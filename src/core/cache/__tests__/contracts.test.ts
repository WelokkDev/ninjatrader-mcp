import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import { ingestCandles } from "../../../bridge/ingest.js";
import { classifySessionDay } from "../fill.js";
import {
  assignFrontContract,
  contractEventsFor,
  describeContractEvent,
  frontContractFor,
  servedContracts,
} from "../contracts.js";

// One session-day, NQ 2026-06-12 (22:00 UTC the evening before, 23h long).
const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);
const START = unix(2026, 6, 11, 22);
const END = START + 82_800;
const AFTER = END + 3_600;
const DAY = { label: "2026-06-12", startUnix: START, endUnix: END };

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function bars15m(fromIdx: number, toIdx: number, base = 100) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    out.push({
      timestamp: START + i * 900,
      open: base + i, high: base + 1 + i, low: base - 1 + i, close: base + 0.5 + i, volume: 10,
    });
  }
  return out;
}

function barsAt(period: number, fromIdx: number, toIdx: number, base = 100) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    out.push({
      timestamp: START + i * period,
      open: base + 1, high: base + 2, low: base, close: base + 1.5, volume: 10,
    });
  }
  return out;
}

function unattestedStored(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM bars
          WHERE symbol = 'NQ' AND contract = '' AND timestamp > ? AND timestamp <= ?`,
      )
      .get(START, END) as { n: number }
  ).n;
}

function fetch(db: Database.Database, contract: string | null, from = 1, to = 92, base = 100) {
  ingestCandles("NQ", "15m", bars15m(from, to, base), db, {
    mode: "day-refill",
    nowUnix: AFTER,
    contractForDay: () => contract,
  });
}

function live(db: Database.Database, contract: string | null, from: number, to: number, base = 100) {
  ingestCandles("NQ", "15m", bars15m(from, to, base), db, {
    mode: "append",
    nowUnix: AFTER,
    contractForDay: () => contract,
  });
}

function served(db: Database.Database, tf = "15m") {
  return db
    .prepare(
      `SELECT timestamp, close, contract FROM candles
        WHERE symbol = 'NQ' AND timeframe = ? AND timestamp > ? AND timestamp <= ?
        ORDER BY timestamp`,
    )
    .all(tf, START, END) as Array<{ timestamp: number; close: number; contract: string | null }>;
}

function stored(db: Database.Database, tf = "15m") {
  return db
    .prepare(
      `SELECT timestamp, contract, front FROM bars
        WHERE symbol = 'NQ' AND timeframe = ? AND timestamp > ? AND timestamp <= ?
        ORDER BY timestamp, contract`,
    )
    .all(tf, START, END) as Array<{ timestamp: number; contract: string; front: number }>;
}

function events(db: Database.Database) {
  return contractEventsFor(db, "NQ", DAY.label, DAY.label);
}

type Log = { mock: { calls: unknown[][] } };

function quiet<T>(fn: (log: Log) => T): T {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return fn(log as unknown as Log);
  } finally {
    log.mockRestore();
  }
}

function lines(log: Log, needle: string): string[] {
  return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(needle));
}

describe("two contracts on one session-day", () => {
  it("a live stream on another contract keeps its bars off-front: stored, logged once, not served", () => {
    quiet((log) => {
      const db = memDb();
      fetch(db, "NQ 09-26");
      live(db, "NQ 12-26", 1, 4, 300);

      expect(frontContractFor(db, "NQ", DAY.label)).toMatchObject({
        contract: "NQ 09-26",
        decidedBy: "fetch",
      });
      const rows = served(db);
      expect(rows).toHaveLength(92);
      expect(rows.every((r) => r.contract === "NQ 09-26" && r.close < 300)).toBe(true);
      expect(stored(db).filter((r) => r.contract === "NQ 12-26")).toEqual(
        [1, 2, 3, 4].map((i) => ({ timestamp: START + i * 900, contract: "NQ 12-26", front: 0 })),
      );
      expect(events(db)).toEqual([
        expect.objectContaining({ kind: "off_front", from: "NQ 09-26", to: "NQ 12-26", count: 4 }),
      ]);
      expect(lines(log, "OFF-FRONT BARS")).toHaveLength(1);

      live(db, "NQ 12-26", 5, 6, 300);
      expect(events(db)[0].count).toBe(6);
      expect(lines(log, "OFF-FRONT BARS")).toHaveLength(1);
    });
  });

  it("a fetch under the next contract moves the front and keeps the old contract's rows", () => {
    quiet((log) => {
      const db = memDb();
      fetch(db, "NQ 09-26");
      fetch(db, "NQ 12-26", 1, 92, 300);

      expect(frontContractFor(db, "NQ", DAY.label)).toMatchObject({ contract: "NQ 12-26" });
      const rows = served(db);
      expect(rows).toHaveLength(92);
      expect(rows.every((r) => r.contract === "NQ 12-26" && r.close >= 300)).toBe(true);
      const sep = stored(db).filter((r) => r.contract === "NQ 09-26");
      expect(sep).toHaveLength(92);
      expect(sep.every((r) => r.front === 0)).toBe(true);
      expect(served(db, "1h").every((r) => r.contract === "NQ 12-26")).toBe(true);
      expect(served(db, "1h").length).toBeGreaterThan(0);

      expect(events(db)).toEqual([
        expect.objectContaining({ kind: "reassigned", from: "NQ 09-26", to: "NQ 12-26" }),
      ]);
      expect(events(db)[0].detail).toContain("kept, no longer served");
      expect(lines(log, "FRONT CONTRACT MOVED")).toHaveLength(1);
    });
  });

  it("a day inherited with two contracts served (the 2026-09-14 shape) resolves on its next fetch", () => {
    quiet(() => {
      const db = memDb();
      // The migration leaves legacy rows served as they were, with no assignment.
      const seed = db.prepare(
        `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume, contract)
         VALUES ('NQ', '15m', ?, 1, 2, 0.5, 1.5, 10, ?)`,
      );
      for (let i = 1; i <= 92; i++) seed.run(START + i * 900, i % 2 ? "NQ 09-26" : "NQ 12-26");
      expect(servedContracts(db, "NQ", "15m", [DAY])).toEqual({
        contracts: ["NQ 09-26", "NQ 12-26"],
        mixedDays: [{ day: DAY.label, contracts: ["NQ 09-26", "NQ 12-26"] }],
      });

      fetch(db, "NQ 12-26", 1, 92, 300);

      expect(servedContracts(db, "NQ", "15m", [DAY])).toEqual({
        contracts: ["NQ 12-26"],
        mixedDays: [],
      });
      expect(served(db)).toHaveLength(92);
      expect(stored(db).filter((r) => r.contract === "NQ 09-26")).toHaveLength(46);
      expect(stored(db).filter((r) => r.contract === "NQ 09-26" && r.front === 1)).toHaveLength(0);
      expect(events(db)).toEqual([
        expect.objectContaining({ kind: "reassigned", from: "NQ 09-26", to: "NQ 12-26" }),
      ]);
    });
  });

  it("unattested bars file under the day's front; an attested fetch replaces them instant for instant", () => {
    quiet(() => {
      const db = memDb();
      fetch(db, null);
      expect(frontContractFor(db, "NQ", DAY.label)).toBeNull();
      expect(served(db)).toHaveLength(92);
      expect(served(db).every((r) => r.contract === null)).toBe(true);
      expect(servedContracts(db, "NQ", "15m", [DAY]).contracts).toEqual(["unattested"]);

      fetch(db, "NQ 09-26");
      expect(stored(db).filter((r) => r.contract === "")).toHaveLength(0);
      expect(served(db).every((r) => r.contract === "NQ 09-26")).toBe(true);
      expect(events(db)).toEqual([]);

      fetch(db, null, 1, 92, 500);
      expect(served(db).every((r) => r.contract === "NQ 09-26" && r.close >= 500)).toBe(true);
      expect(events(db)).toEqual([]);
    });
  });

  it("a live bar claims a day nothing has claimed; the next fetch's answer then wins", () => {
    quiet(() => {
      const db = memDb();
      live(db, "NQ 06-26", 1, 2);
      expect(frontContractFor(db, "NQ", DAY.label)).toMatchObject({
        contract: "NQ 06-26",
        decidedBy: "live",
      });
      expect(served(db)).toHaveLength(2);

      fetch(db, "NQ 09-26");
      expect(frontContractFor(db, "NQ", DAY.label)).toMatchObject({
        contract: "NQ 09-26",
        decidedBy: "fetch",
      });
      expect(served(db).every((r) => r.contract === "NQ 09-26")).toBe(true);
      expect(stored(db).filter((r) => r.contract === "NQ 06-26")).toEqual([
        { timestamp: START + 900, contract: "NQ 06-26", front: 0 },
        { timestamp: START + 1800, contract: "NQ 06-26", front: 0 },
      ]);
      expect(events(db)).toEqual([
        expect.objectContaining({ kind: "reassigned", from: "NQ 06-26", to: "NQ 09-26" }),
      ]);
    });
  });

  it("one attested bar at another timeframe hides a day's unattested bars and deletes none", () => {
    quiet((log) => {
      const db = memDb();
      ingestCandles("NQ", "5m", barsAt(300, 1, 276), db, {
        mode: "day-refill", nowUnix: AFTER, contractForDay: () => null,
      });
      fetch(db, null); // 92 x 15m, plus the 87 rows derived from them
      const before = unattestedStored(db);
      expect(before).toBe(276 + 92 + 87);

      ingestCandles(
        "NQ", "1d",
        [{ timestamp: END, open: 100, high: 300, low: 50, close: 200, volume: 1000 }],
        db,
        { mode: "day-refill", nowUnix: AFTER, contractForDay: () => "NQ 09-26" },
      );

      expect(unattestedStored(db)).toBe(before);
      expect(served(db, "5m")).toHaveLength(0);
      expect(served(db, "15m")).toHaveLength(0);
      expect(served(db, "1d")).toHaveLength(1);
      // Raw bars only: the derived rows are rebuilt, not re-fetched.
      expect(events(db)).toEqual([
        expect.objectContaining({
          kind: "unattested_hidden", from: "", to: "NQ 09-26", count: 276 + 92,
        }),
      ]);
      expect(lines(log, "UNATTESTED BARS HIDDEN")).toHaveLength(1);

      ingestCandles("NQ", "5m", barsAt(300, 1, 276, 500), db, {
        mode: "day-refill", nowUnix: AFTER, contractForDay: () => "NQ 09-26",
      });
      expect(served(db, "5m")).toHaveLength(276);
      expect(stored(db, "5m").filter((r) => r.contract === "")).toHaveLength(0);
      expect(stored(db, "15m").filter((r) => r.contract === "")).toHaveLength(92);
      const replaced = lines(log, "UNATTESTED BARS REPLACED");
      expect(replaced).toHaveLength(1);
      expect(replaced[0]).toContain("276 bar(s)");
      expect(replaced[0]).toContain("NQ 5m 2026-06-12");
    });
  });

  it("a live bar claiming a day deletes nothing: the day's unattested fetch is hidden, not lost", () => {
    quiet(() => {
      const db = memDb();
      const during = START + 24 * 900 + 60;
      ingestCandles("NQ", "15m", bars15m(1, 24), db, {
        mode: "day-refill", nowUnix: during, contractForDay: () => null,
      });
      const before = unattestedStored(db);
      expect(before).toBeGreaterThanOrEqual(24);

      ingestCandles("NQ", "5m", barsAt(300, 1, 1), db, {
        mode: "append", nowUnix: during, contractForDay: () => "NQ 09-26",
      });

      expect(frontContractFor(db, "NQ", DAY.label)).toMatchObject({
        contract: "NQ 09-26",
        decidedBy: "live",
      });
      expect(unattestedStored(db)).toBe(before);
      expect(served(db, "15m")).toHaveLength(0);
      expect(served(db, "5m")).toHaveLength(1);
      expect(events(db)).toEqual([
        expect.objectContaining({
          kind: "unattested_hidden", to: "NQ 09-26", count: 24, detail: "decided by live",
        }),
      ]);
    });
  });

  it("refuses to make 'unattested' a day's front", () => {
    const db = memDb();
    expect(() => assignFrontContract(db, "NQ", DAY, "", "fetch", AFTER)).toThrow(/attested/);
  });

  it("re-asserting the current front changes nothing", () => {
    const db = memDb();
    quiet(() => fetch(db, "NQ 09-26"));
    const before = stored(db);
    const outcome = assignFrontContract(db, "NQ", DAY, "NQ 09-26", "fetch", AFTER);
    expect(outcome).toEqual({
      changed: false, previous: "NQ 09-26", displaced: [], hiddenRows: 0, hiddenUnattested: 0,
    });
    expect(stored(db)).toEqual(before);
    expect(events(db)).toEqual([]);
  });

  it("events read as one dated line each", () => {
    const at = Date.UTC(2026, 9, 3, 21, 17) / 1000;
    const event = { symbol: "NQ", firstTs: at, lastTs: at };
    expect(
      describeContractEvent({
        ...event, sessionDay: "2026-09-14", kind: "reassigned",
        from: "NQ 09-26", to: "NQ 12-26", count: 1,
        detail: "9230 bar(s) kept, no longer served; decided by fetch",
      }),
    ).toBe(
      "2026-09-14: front contract moved NQ 09-26 → NQ 12-26 on 2026-10-03 21:17 UTC (9230 bar(s) kept, no longer served; decided by fetch)",
    );
    expect(
      describeContractEvent({
        ...event, sessionDay: "2026-09-14", kind: "off_front",
        from: "NQ 12-26", to: "NQ 09-26", count: 7519, detail: "1s live",
      }),
    ).toBe(
      "2026-09-14: 7519 bar(s) arrived under NQ 09-26 while the front contract is NQ 12-26, last 2026-10-03 21:17 UTC — stored, not served (1s live)",
    );
    expect(
      describeContractEvent({
        ...event, sessionDay: "2026-03-10", kind: "unattested_hidden",
        from: "", to: "NQ 06-26", count: 368, detail: "decided by fetch",
      }),
    ).toBe(
      "2026-03-10: 368 bar(s) with no contract label stopped being served on 2026-10-03 21:17 UTC, when the front contract became NQ 06-26 — kept, not deleted; re-fetch those timeframes to replace them (decided by fetch)",
    );
    expect(
      describeContractEvent({
        ...event, sessionDay: "2026-09-14", kind: "bound_mismatch",
        from: "NQ 12-26", to: "NQ 09-26", count: 3, detail: "1s fetch",
      }),
    ).toBe(
      "2026-09-14: NinjaTrader's rollover table says NQ 12-26 but the AddOn bound NQ 09-26 on 3 fetch(es), last 2026-10-03 21:17 UTC — a live stream resolved the same way is off-front; check live_feed_status and re-subscribe (1s fetch)",
    );
  });
});

describe("a mixed day is not finished", () => {
  function seedAlternating(db: Database.Database, a: string | null, b: string | null): void {
    const seed = db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume, contract)
       VALUES ('NQ', '15m', ?, 1, 2, 0.5, 1.5, 10, ?)`,
    );
    for (let i = 1; i <= 92; i++) seed.run(START + i * 900, i % 2 ? a : b);
  }

  it("counts as incomplete until a fetch assigns its front", () => {
    quiet(() => {
      const db = memDb();
      seedAlternating(db, "NQ 09-26", "NQ 12-26");
      expect(classifySessionDay(db, "NQ", DAY, "15m", AFTER)).toBe("partial");

      fetch(db, "NQ 12-26", 1, 92, 300);
      expect(classifySessionDay(db, "NQ", DAY, "15m", AFTER)).toBe("complete");
    });
  });

  it("labelled and unlabelled bars served together count as mixed too", () => {
    const db = memDb();
    seedAlternating(db, "NQ 09-26", null);
    expect(classifySessionDay(db, "NQ", DAY, "15m", AFTER)).toBe("partial");
  });

  it("a day under one contract, or wholly unlabelled, is complete as before", () => {
    quiet(() => {
      const one = memDb();
      fetch(one, "NQ 09-26");
      expect(classifySessionDay(one, "NQ", DAY, "15m", AFTER)).toBe("complete");

      const unlabelled = memDb();
      fetch(unlabelled, null);
      expect(classifySessionDay(unlabelled, "NQ", DAY, "15m", AFTER)).toBe("complete");
    });
  });
});
