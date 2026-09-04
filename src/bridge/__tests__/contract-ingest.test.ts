import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import {
  createBarCloseHandler,
  createCandlesResponseHandler,
  ingestCandles,
} from "../ingest.js";
import { getInstrumentConfig } from "../../core/sessions/registry.js";
import { loadCalendar } from "../../core/sessions/calendar.js";
import { recomputeDerivedForSessionDay } from "../../core/cache/derived.js";
import {
  canonicalContract,
  contractForLabel,
  contractName,
  parseContractName,
  sameContract,
  windowsFromResponse,
} from "../contract-windows.js";
import { parseMessage, type CandlesResponseMessage } from "../protocol.js";

// Contract identity through the ingest write paths: the rollover table NT8
// sends with each fetch labels merged historical bars; a bar_close labels
// itself. Fixtures use the real June-2026 NQ roll into 09-26 on 2026-06-12.

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-days label = close-date; EDT sessions start 22:00 UTC the day
// before and run 23h.
const dayStart = (y: number, mo1: number, d: number): number => unix(y, mo1, d - 1, 22);
const D11_START = dayStart(2026, 6, 11); // session 2026-06-11 (old contract)
const D12_START = dayStart(2026, 6, 12); // session 2026-06-12 (NT8 rolls here)
const D12_END = D12_START + 82_800;
const AFTER = D12_END + 3_600;

const NQ_ROLLOVERS = [
  { contractMonth: "2026-06-01", rolloverDate: "2026-03-16" },
  { contractMonth: "2026-09-01", rolloverDate: "2026-06-12" },
];

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function bars15m(startUnix: number, fromIdx: number, toIdx: number) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    out.push({
      timestamp: startUnix + i * 900,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10,
    });
  }
  return out;
}

function response(over: Partial<CandlesResponseMessage> = {}): CandlesResponseMessage {
  return {
    v: 1,
    id: "t",
    type: "candles_response",
    symbol: "NQ",
    timeframe: "15m",
    candles: bars15m(D12_START, 1, 92),
    dataSource: "My Broker Feed",
    contract: "NQ SEP26",
    rollovers: NQ_ROLLOVERS,
    ...over,
  };
}

function contractsOf(db: Database.Database, tf: string, start: number, end: number) {
  return (
    db
      .prepare(
        `SELECT DISTINCT contract AS ct FROM candles
          WHERE symbol='NQ' AND timeframe=? AND timestamp > ? AND timestamp <= ?
          ORDER BY ct`,
      )
      .all(tf, start, end) as Array<{ ct: string | null }>
  ).map((r) => r.ct);
}

function crossCheckWarns(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes("contract cross-check"));
}

describe("contract-windows mapping", () => {
  it("formats delivery months the way the private consumer spells them", () => {
    // Byte-equal with the private consumer's derivation: they compare by
    // string equality.
    expect(contractName("NQ", "2026-09-01")).toBe("NQ 09-26");
    expect(contractName("MNQ", "2027-03-01")).toBe("MNQ 03-27");
  });

  it("reads a delivery month out of BOTH renderings NT8 uses", () => {
    expect(parseContractName("NQ SEP26")).toEqual({ symbol: "NQ", year: 2026, month: 9 });
    expect(parseContractName("NQ 09-26")).toEqual({ symbol: "NQ", year: 2026, month: 9 });
    expect(parseContractName("MNQ dec27")).toEqual({ symbol: "MNQ", year: 2027, month: 12 });
    expect(parseContractName("NQ")).toBeNull();
    expect(parseContractName("NQ 13-26")).toBeNull(); // no 13th month
    expect(parseContractName("NQ XYZ26")).toBeNull();
  });

  it("treats the two spellings as one contract, and unparseable names as literal", () => {
    expect(sameContract("NQ SEP26", "NQ 09-26")).toBe(true);
    expect(sameContract("NQ SEP26", "NQ DEC26")).toBe(false);
    expect(sameContract("NQ SEP26", "MNQ SEP26")).toBe(false);
    expect(sameContract("weird", "NQ 09-26")).toBe(false);
    expect(sameContract("weird", "weird")).toBe(true);
    expect(sameContract(undefined, "NQ 09-26")).toBe(false);
  });

  it("stores one spelling", () => {
    expect(canonicalContract("NQ SEP26")).toBe("NQ 09-26");
    expect(canonicalContract("NQ 06-26")).toBe("NQ 06-26");
    expect(canonicalContract("weird")).toBe("weird"); // never invent a label
    expect(canonicalContract(undefined)).toBeNull();
  });

  it("sorts windows ascending whatever order NT8 sends them in", () => {
    const w = windowsFromResponse([NQ_ROLLOVERS[1], NQ_ROLLOVERS[0]], "NQ");
    expect(w.map((x) => x.rolloverDate)).toEqual(["2026-03-16", "2026-06-12"]);
    expect(windowsFromResponse(undefined, "NQ")).toEqual([]);
  });

  it("refuses a corrupt table whole — one non-canonical date labels nothing", () => {
    // Dropping just the bad row would shift attribution for its neighbours.
    const bad = [...NQ_ROLLOVERS, { contractMonth: "2026-12-01", rolloverDate: "2026-9-14" }];
    expect(windowsFromResponse(bad, "NQ")).toEqual([]);

    const db = memDb();
    createCandlesResponseHandler(db)(response({ rollovers: bad }));
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([null]);
  });

  it("rejects a calendar-impossible date the regex alone would pass", () => {
    // "2026-02-30" matches the regex and new Date() rolls it into March; only
    // the round-trip catches it.
    const bad = [...NQ_ROLLOVERS, { contractMonth: "2026-02-30", rolloverDate: "2026-09-14" }];
    expect(windowsFromResponse(bad, "NQ")).toEqual([]);
  });

  it("maps a label to the window containing it, rolling AT the rollover date", () => {
    const w = windowsFromResponse(NQ_ROLLOVERS, "NQ");
    expect(contractForLabel(w, "NQ", "2026-06-11")).toBe("NQ 06-26");
    expect(contractForLabel(w, "NQ", "2026-06-12")).toBe("NQ 09-26");
    expect(contractForLabel(w, "NQ", "2026-08-15")).toBe("NQ 09-26");
  });

  it("returns null before the earliest window and when there are no windows", () => {
    const w = windowsFromResponse(NQ_ROLLOVERS, "NQ");
    expect(contractForLabel(w, "NQ", "2026-03-15")).toBeNull();
    expect(contractForLabel([], "NQ", "2026-06-12")).toBeNull();
  });
});

describe("candles_response labels from the table NT8 merged across", () => {
  it("a merged fetch spanning the roll stamps each side with its own contract", () => {
    // One response, two contracts — a response-level label mislabels one side.
    const db = memDb();
    createCandlesResponseHandler(db)(
      response({ candles: [...bars15m(D11_START, 1, 92), ...bars15m(D12_START, 1, 92)] }),
    );
    expect(contractsOf(db, "15m", D11_START, D11_START + 82_800)).toEqual(["NQ 06-26"]);
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 09-26"]);
    // Derived rows inherit per day, same rule as price_basis.
    expect(contractsOf(db, "1h", D11_START, D11_START + 82_800)).toEqual(["NQ 06-26"]);
    expect(contractsOf(db, "1h", D12_START, D12_END)).toEqual(["NQ 09-26"]);
  });

  it("labels from the bound instrument when NT8 had no table to merge with", () => {
    const db = memDb();
    createCandlesResponseHandler(db)(response({ rollovers: [] }));
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 09-26"]);
  });

  it("labels from the bound instrument under DoNotMerge, whatever the table says", () => {
    const db = memDb();
    createCandlesResponseHandler(db)(
      response({ candles: bars15m(D11_START, 1, 92), mergePolicy: "DoNotMerge" }),
    );
    expect(contractsOf(db, "15m", D11_START, D11_START + 82_800)).toEqual(["NQ 09-26"]);
  });

  it("stores NULL when the table could not be read — unattested, never guessed", () => {
    const db = memDb();
    createCandlesResponseHandler(db)(response({ rollovers: undefined }));
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([null]);
  });

  it("a null table on the wire is 'could not read', and never costs the fetch", () => {
    const raw = JSON.stringify({ ...response(), rollovers: null });
    const parsed = parseMessage(raw);
    expect(parsed.ok).toBe(true);
    const db = memDb();
    createCandlesResponseHandler(db)(response({ rollovers: null }));
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([null]);
  });

  it("never downgrades an attested day to NULL on a refill that cannot attest", () => {
    const db = memDb();
    createCandlesResponseHandler(db)(response()); // attested NQ 09-26
    createCandlesResponseHandler(db)(response({ rollovers: undefined }));
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 09-26"]);
  });

  it("the same contract in NT8's other spelling is not a mismatch", () => {
    // The table produces "NQ 09-26"; the bound instrument reports "NQ SEP26".
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createCandlesResponseHandler(memDb())(response({ contract: "NQ SEP26" }));
      expect(crossCheckWarns(log)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("the cross-check warn names the NEWEST mismatching day, not the oldest", () => {
    // Days iterate ascending, so a first-hit latch always fires on the oldest
    // (expected) day and hides the interesting case.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createCandlesResponseHandler(memDb())(
        response({
          candles: [...bars15m(D11_START, 1, 92), ...bars15m(D12_START, 1, 92)],
          rollovers: [...NQ_ROLLOVERS, { contractMonth: "2026-12-01", rolloverDate: "2026-09-14" }],
          contract: "NQ DEC26", // mismatches BOTH days' windows
        }),
      );
      const warns = crossCheckWarns(log);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("2026-06-12");
      expect(warns[0]).not.toContain("2026-06-11");
    } finally {
      log.mockRestore();
    }
  });
});

describe("bar_close labels by what actually produced the bar", () => {
  const candle = {
    timestamp: D12_START + 900,
    open: 1, high: 2, low: 0.5, close: 1.5, volume: 3,
  };

  it("a live bar is the subscribed instrument's own trade — msg.contract wins", () => {
    // NT8's series rolled on 06-12 but this subscription still serves June.
    // Taking September from the table would attest bars it never traded.
    const db = memDb();
    createBarCloseHandler(db)({
      v: 1, type: "bar_close", symbol: "NQ", timeframe: "15m",
      candle, contract: "NQ 06-26", dataSource: "My Broker Feed",
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 06-26"]);
  });

  it("lands in the stored spelling — a live 'NQ SEP26' is 'NQ 09-26' on disk", () => {
    const db = memDb();
    createBarCloseHandler(db)({
      v: 1, type: "bar_close", symbol: "NQ", timeframe: "15m",
      candle, contract: "NQ SEP26", dataSource: "My Broker Feed",
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 09-26"]);
  });

  it("a backfill bar is STILL the subscription's own trade — msg.contract wins", () => {
    // `backfill` is a staleness tag, not provenance.
    const db = memDb();
    createBarCloseHandler(db)({
      v: 1, type: "bar_close", symbol: "NQ", timeframe: "15m",
      candle, contract: "NQ 06-26", dataSource: "My Broker Feed", backfill: true,
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 06-26"]);
  });

  it("warns when a live bar names a different contract than the day's fetched rows", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = memDb();
      createCandlesResponseHandler(db)(response());
      createBarCloseHandler(db)({
        v: 1, type: "bar_close", symbol: "NQ", timeframe: "15m",
        candle, contract: "NQ 06-26", dataSource: "My Broker Feed",
      });
      const warns = log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("contract mismatch"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("NQ 06-26");
      expect(warns[0]).toContain("NQ 09-26");
    } finally {
      log.mockRestore();
    }
  });

  it("an old AddOn without the field stores NULL — never a guess", () => {
    const db = memDb();
    createBarCloseHandler(db)({
      v: 1, type: "bar_close", symbol: "NQ", timeframe: "15m",
      candle, dataSource: "My Broker Feed",
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([null]);
  });
});

describe("derived-contract rule under heterogeneity", () => {
  it("a day whose 15m rows carry TWO contracts derives NULL, not a coin flip", () => {
    // Merged fetch and stale subscription both wrote this day.
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(D12_START, 1, 92), db, {
      mode: "day-refill",
      nowUnix: AFTER,
      contractForDay: () => "NQ 09-26",
    });
    db.prepare(
      `UPDATE candles SET contract = 'NQ 06-26'
        WHERE symbol='NQ' AND timeframe='15m' AND timestamp <= ?`,
    ).run(D12_START + 46 * 900);

    const config = getInstrumentConfig("NQ");
    const calendar = loadCalendar(db, config.session.name);
    recomputeDerivedForSessionDay(
      db, "NQ",
      { label: "2026-06-12", startUnix: D12_START, endUnix: D12_END },
      config, calendar, AFTER,
    );
    for (const tf of ["30m", "1h", "2h", "4h"]) {
      expect(contractsOf(db, tf, D12_START, D12_END), tf).toEqual([null]);
    }
  });
});
