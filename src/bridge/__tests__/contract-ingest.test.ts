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
  contractForLabel,
  contractName,
  loadRolloverWindows,
  parseContractName,
  sameContract,
} from "../contract-windows.js";

// Contract identity through the ingest write paths: mirror windows label
// merged historical fetches, the bar_close `contract` field labels live bars.
// Fixtures use the real June-2026 NQ roll into 09-26 on 2026-06-12.

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-days label = close-date; EDT sessions start 22:00 UTC the day
// before and run 23h.
const dayStart = (y: number, mo1: number, d: number): number => unix(y, mo1, d - 1, 22);
const D11_START = dayStart(2026, 6, 11); // session 2026-06-11 (old contract)
const D12_START = dayStart(2026, 6, 12); // session 2026-06-12 (NT8 rolls here)
const D12_END = D12_START + 82_800;
const AFTER = D12_END + 3_600;
// Fixed clock: the attestation gate asks which window is open "today".
const NOW = Date.UTC(2026, 8, 2) / 1000; // 2026-09-02

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  db.prepare(
    `INSERT INTO contract_rollovers
       (symbol, contract_month, rollover_date, offset_points, was_edited, fetched_at)
     VALUES (?, ?, ?, ?, 0, 1)`,
  ).run("NQ", "2026-06-01", "2026-03-16", 208.75);
  db.prepare(
    `INSERT INTO contract_rollovers
       (symbol, contract_month, rollover_date, offset_points, was_edited, fetched_at)
     VALUES (?, ?, ?, ?, 0, 1)`,
  ).run("NQ", "2026-09-01", "2026-06-12", 282.25);
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

describe("contract-windows mapping", () => {
  it("formats delivery months the way NT8 spells FullName", () => {
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
    // Unknown format must never be assumed to match something.
    expect(sameContract("weird", "NQ 09-26")).toBe(false);
    expect(sameContract("weird", "weird")).toBe(true);
    expect(sameContract(undefined, "NQ 09-26")).toBe(false);
  });

  it("refuses a corrupt mirror whole — one non-canonical date labels nothing", () => {
    // Dropping just the bad row would shift attribution for its neighbours.
    const db = memDb();
    db.prepare(
      `INSERT INTO contract_rollovers
         (symbol, contract_month, rollover_date, offset_points, was_edited, fetched_at)
       VALUES ('NQ', '2026-12-01', '2026-9-14', 0, 0, 1)`, // non-canonical rollover_date
    ).run();
    expect(loadRolloverWindows(db, "NQ")).toEqual([]);

    // ...and ingest stores NULL rather than a label off a refused mirror.
    createCandlesResponseHandler(db)({
      v: 1,
      id: "t-corrupt",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "15m",
      candles: bars15m(D12_START, 1, 92),
      dataSource: "My Broker Feed",
      contract: "NQ 09-26",
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([null]);
  });

  it("rejects a calendar-impossible date the regex alone would pass", () => {
    // "2026-02-30" matches the regex and new Date() rolls it into March; only
    // the round-trip catches it. Corrupts contract_month, where the sibling
    // test corrupts rollover_date, so both arms are exercised.
    const db = memDb();
    db.prepare(
      `INSERT INTO contract_rollovers
         (symbol, contract_month, rollover_date, offset_points, was_edited, fetched_at)
       VALUES ('NQ', '2026-02-30', '2026-09-14', 0, 0, 1)`,
    ).run();
    expect(loadRolloverWindows(db, "NQ")).toEqual([]);
  });

  it("never caches a pinned response — one expiry's series is not the front-month view", () => {
    const db = memDb();
    createCandlesResponseHandler(db, () => NOW)({
      v: 1,
      id: "t-pinned",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "15m",
      candles: bars15m(D12_START, 1, 92),
      dataSource: "My Broker Feed",
      contract: "NQ SEP26",
      pinned: true,
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([]);
  });

  it("caches normally when NT8 spells the SAME contract the other way round", () => {
    // The mirror only builds "NQ 09-26"; FullName here is "NQ SEP26". Comparing
    // those as strings refuses every correct fetch.
    const db = memDb();
    createCandlesResponseHandler(db, () => NOW)({
      v: 1,
      id: "t-spelling",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "15m",
      candles: bars15m(D12_START, 1, 92),
      dataSource: "My Broker Feed",
      contract: "NQ SEP26", // same contract the mirror calls NQ 09-26
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 09-26"]);
  });

  it("refuses bars from a contract whose rollover window has not opened yet", () => {
    // NT8 ran ahead of its own table and bound December while September was
    // still front — provably wrong, so nothing is cached.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = memDb();
      db.prepare(
        `INSERT INTO contract_rollovers
           (symbol, contract_month, rollover_date, offset_points, was_edited, fetched_at)
         VALUES (?, ?, ?, ?, 0, 1)`,
      ).run("NQ", "2026-12-01", "2026-09-14", 0); // opens 12 days after NOW
      createCandlesResponseHandler(db, () => NOW)({
        v: 1,
        id: "t-refuse",
        type: "candles_response",
        symbol: "NQ",
        timeframe: "15m",
        candles: bars15m(D12_START, 1, 92),
        dataSource: "My Broker Feed",
        contract: "NQ DEC26",
      });
      expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([]);
      const refusals = log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("REFUSED"));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("2026-09-14");
    } finally {
      log.mockRestore();
    }
  });

  it("caches, loudly, when the mirror simply has not seen the roll yet", () => {
    // Indistinguishable from a wrong bind except that no window names the bound
    // contract. Refusing here would stop all caching for days after a real roll.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = memDb(); // no December window: mirror predates the roll
      const afterRoll = Date.UTC(2026, 8, 20) / 1000; // 2026-09-20
      createCandlesResponseHandler(db, () => afterRoll)({
        v: 1,
        id: "t-stale",
        type: "candles_response",
        symbol: "NQ",
        timeframe: "15m",
        candles: bars15m(D12_START, 1, 92),
        dataSource: "My Broker Feed",
        contract: "NQ DEC26",
      });
      expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 09-26"]);
      const warns = log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("contract attestation"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("NQ DEC26");
    } finally {
      log.mockRestore();
    }
  });

  it("the cross-check warn names the NEWEST mismatching day, not the oldest", () => {
    // A first-hit latch always fires on the oldest (expected) day. Needs a clock
    // past a third rollover so the bound contract is front and passes the gate.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = memDb();
      db.prepare(
        `INSERT INTO contract_rollovers
           (symbol, contract_month, rollover_date, offset_points, was_edited, fetched_at)
         VALUES (?, ?, ?, ?, 0, 1)`,
      ).run("NQ", "2026-12-01", "2026-09-14", 0);
      const afterRoll = Date.UTC(2026, 8, 20) / 1000; // 2026-09-20, Dec is front
      createCandlesResponseHandler(db, () => afterRoll)({
        v: 1,
        id: "t-newest",
        type: "candles_response",
        symbol: "NQ",
        timeframe: "15m",
        candles: [...bars15m(D11_START, 1, 92), ...bars15m(D12_START, 1, 92)],
        dataSource: "My Broker Feed",
        contract: "NQ DEC26",
      });
      const warns = log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("contract cross-check"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("2026-06-12"); // the newest mismatching day
      expect(warns[0]).not.toContain("2026-06-11");
    } finally {
      log.mockRestore();
    }
  });

  it("maps a label to the window containing it, rolling AT the rollover date", () => {
    const db = memDb();
    const windows = loadRolloverWindows(db, "NQ");
    expect(contractForLabel(windows, "NQ", "2026-06-11")).toBe("NQ 06-26");
    // label >= rolloverDate means the new contract.
    expect(contractForLabel(windows, "NQ", "2026-06-12")).toBe("NQ 09-26");
    expect(contractForLabel(windows, "NQ", "2026-08-15")).toBe("NQ 09-26");
  });

  it("returns null before the earliest window and for an unsynced mirror", () => {
    const db = memDb();
    const windows = loadRolloverWindows(db, "NQ");
    expect(contractForLabel(windows, "NQ", "2026-03-15")).toBeNull();
    expect(contractForLabel([], "NQ", "2026-06-12")).toBeNull();
  });
});

describe("candles_response labels rows from the mirror, per day", () => {
  it("a merged fetch spanning the roll stamps each side with its own contract", () => {
    // One response, two contracts — a response-level label mislabels one side.
    const db = memDb();
    createCandlesResponseHandler(db)({
      v: 1,
      id: "t1",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "15m",
      candles: [...bars15m(D11_START, 1, 92), ...bars15m(D12_START, 1, 92)],
      dataSource: "My Broker Feed",
      priceBasis: "as_traded",
      mergePolicy: "MergeNonBackAdjusted",
      contract: "NQ 09-26", // the resolved instrument — current window only
    });
    expect(contractsOf(db, "15m", D11_START, D11_START + 82_800)).toEqual(["NQ 06-26"]);
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 09-26"]);
    // Derived rows inherit per day, same rule as price_basis.
    expect(contractsOf(db, "1h", D11_START, D11_START + 82_800)).toEqual(["NQ 06-26"]);
    expect(contractsOf(db, "1h", D12_START, D12_END)).toEqual(["NQ 09-26"]);
  });

  it("an unsynced mirror stores NULL — unattested, never guessed from the response", () => {
    const db = new Database(":memory:");
    initializeSchema(db); // no mirror rows
    createCandlesResponseHandler(db)({
      v: 1,
      id: "t2",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "15m",
      candles: bars15m(D12_START, 1, 92),
      dataSource: "My Broker Feed",
      contract: "NQ 09-26",
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual([null]);
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

  it("a backfill bar is STILL the subscription's own trade — msg.contract wins", () => {
    // `backfill` is a staleness tag, not provenance — a catch-up flush is
    // still the subscription's own trade.
    const db = memDb();
    createBarCloseHandler(db)({
      v: 1, type: "bar_close", symbol: "NQ", timeframe: "15m",
      candle, contract: "NQ 06-26", dataSource: "My Broker Feed", backfill: true,
    });
    expect(contractsOf(db, "15m", D12_START, D12_END)).toEqual(["NQ 06-26"]);
  });

  it("an old AddOn without the field stores NULL — never the mirror", () => {
    // A mirror label here would make the splice's cross-check circular.
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
