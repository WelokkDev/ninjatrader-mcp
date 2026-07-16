import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { ingestCandles } from "../ingest.js";
import { validateSessionDay } from "../../core/cache/validator.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-day 2026-05-01 (Fri): Apr 30 18:00 EDT → May 1 17:00 EDT.
const DAY_START = unix(2026, 4, 30, 22);
const DAY_END = DAY_START + 82_800; // 23h session
const SD = { label: "2026-05-01", startUnix: DAY_START, endUnix: DAY_END };
const MID_SESSION = DAY_START + 10 * 900 + 300; // 20:35 ET
const AFTER_CLOSE = DAY_END + 3_600;

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function bars15m(fromIdx: number, toIdx: number, startUnix = DAY_START) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    out.push({
      timestamp: startUnix + i * 900,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10,
    });
  }
  return out;
}

function bars5m(fromIdx: number, toIdx: number) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    out.push({
      timestamp: DAY_START + i * 300,
      open: 100, high: 101, low: 99, close: 100.5, volume: 10,
    });
  }
  return out;
}

function stamps(db: Database.Database, tf: string): number[] {
  return (
    db
      .prepare(`SELECT timestamp FROM candles WHERE symbol='NQ' AND timeframe=? ORDER BY timestamp`)
      .all(tf) as Array<{ timestamp: number }>
  ).map((r) => r.timestamp);
}

const canonical = (period: number, count: number, stub?: number): number[] => {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(DAY_START + i * period);
  if (stub !== undefined) out.push(stub);
  return out;
};

describe("ingest convergence", () => {
  it("two-step: mid-session partial buckets converge to the exact canonical set after the full-day refill", () => {
    const db = memDb();

    // Step 1 — mid-session snapshot: 15m data through 20:30 ET.
    ingestCandles("NQ", "15m", bars15m(1, 10), db, { mode: "day-refill", nowUnix: MID_SESSION });
    // Trailing buckets are cut at 20:30 — off-grid at 1h/2h/4h.
    expect(stamps(db, "1h")).toEqual([DAY_START + 3600, DAY_START + 7200, DAY_START + 9000]);
    expect(stamps(db, "4h")).toEqual([DAY_START + 9000]);

    // Step 2 — the whole-day refill fill.ts performs after the session closes.
    ingestCandles("NQ", "15m", bars15m(1, 92), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });

    // Derived rows must be EXACTLY the canonical stamp sets — no 20:30 orphans.
    expect(stamps(db, "1h")).toEqual(canonical(3600, 23));
    expect(stamps(db, "2h")).toEqual(canonical(7200, 11, DAY_END));
    expect(stamps(db, "4h")).toEqual(canonical(14400, 5, DAY_END));
    expect(validateSessionDay(db, "NQ", SD, "4h", AFTER_CLOSE).status).toBe("ok");
  });

  it("day-refill of a closed day removes off-grid raw extras", () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(DAY_START + 450); // off-grid
    ingestCandles("NQ", "5m", bars5m(1, 276), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    expect(stamps(db, "5m")).toHaveLength(276);
    expect(stamps(db, "5m")).not.toContain(DAY_START + 450);
    expect(validateSessionDay(db, "NQ", SD, "5m", AFTER_CLOSE).status).toBe("ok");
  });

  it("append mode never deletes existing raw rows", () => {
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(1, 92), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    // A late live bar re-arrives via bar_close: single-bar append.
    ingestCandles("NQ", "15m", bars15m(5, 5), db, { mode: "append", nowUnix: AFTER_CLOSE });
    expect(stamps(db, "15m")).toHaveLength(92);
    expect(validateSessionDay(db, "NQ", SD, "15m", AFTER_CLOSE).status).toBe("ok");
  });

  it("a truncated day-refill cannot wipe a fuller cached day (canonical rows are never deleted)", () => {
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(1, 92), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    // Degraded/short fetch: only 10 bars for a day with 92 cached.
    ingestCandles("NQ", "15m", bars15m(1, 10), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    expect(stamps(db, "15m")).toHaveLength(92);
    expect(validateSessionDay(db, "NQ", SD, "15m", AFTER_CLOSE).status).toBe("ok");
  });

  it("union semantics for canonical bars: a stamp-disjoint refill cannot destroy locally-held bars", () => {
    const db = memDb();
    // Live capture held bars 1-80 (bridge died before session end)…
    ingestCandles("NQ", "15m", bars15m(1, 80), db, { mode: "append", nowUnix: AFTER_CLOSE });
    // …and the provider's post-close history only reaches back to bar 13.
    ingestCandles("NQ", "15m", bars15m(13, 92), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    // Canonical bars are never deleted: the union completes the day.
    expect(stamps(db, "15m")).toHaveLength(92);
    expect(validateSessionDay(db, "NQ", SD, "15m", AFTER_CLOSE).status).toBe("ok");
  });

  it("a batch spanning two days cannot damage the neighbor: only off-grid rows die", () => {
    const db = memDb();
    // Previous session-day (2026-04-30) fully cached and complete.
    const bStart = unix(2026, 4, 29, 22);
    const dayB = { label: "2026-04-30", startUnix: bStart, endUnix: bStart + 82_800 };
    ingestCandles("NQ", "15m", bars15m(1, 92, bStart), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    // One response carrying day A's full 92 bars plus one stray bar of day B.
    ingestCandles(
      "NQ", "15m",
      [...bars15m(1, 92), ...bars15m(1, 1, bStart)],
      db,
      { mode: "day-refill", nowUnix: AFTER_CLOSE },
    );
    expect(
      db.prepare(
        `SELECT COUNT(*) AS c FROM candles WHERE symbol='NQ' AND timeframe='15m' AND timestamp > ? AND timestamp <= ?`,
      ).get(bStart, dayB.endUnix),
    ).toEqual({ c: 92 });
    expect(validateSessionDay(db, "NQ", dayB, "15m", AFTER_CLOSE).status).toBe("ok");
    expect(validateSessionDay(db, "NQ", SD, "15m", AFTER_CLOSE).status).toBe("ok");
  });

  it("append-mode 15m ingest recomputes derived rows: the previous forming bucket is replaced", () => {
    const db = memDb();
    // Live bar_close path (append) through 20:30…
    ingestCandles("NQ", "15m", bars15m(1, 10), db, { mode: "append", nowUnix: MID_SESSION });
    expect(stamps(db, "1h")).toEqual([DAY_START + 3600, DAY_START + 7200, DAY_START + 9000]);
    // …then the 20:45 bar closes: the forming 20:30 row must be superseded, not accumulated.
    ingestCandles("NQ", "15m", bars15m(11, 11), db, { mode: "append", nowUnix: DAY_START + 11 * 900 + 300 });
    expect(stamps(db, "1h")).toEqual([DAY_START + 3600, DAY_START + 7200, DAY_START + 9900]);
  });

  it("no raw delete on an in-progress day: a lagging refill cannot erase newer live bars", () => {
    const db = memDb();
    // Live bar_close already appended bars through 20:30…
    ingestCandles("NQ", "15m", bars15m(1, 10), db, { mode: "append", nowUnix: MID_SESSION });
    // …then a lagging historical refill arrives covering only through 20:00.
    ingestCandles("NQ", "15m", bars15m(1, 8), db, { mode: "day-refill", nowUnix: MID_SESSION });
    // The newer 20:15/20:30 bars must survive.
    expect(stamps(db, "15m")).toHaveLength(10);
    expect(stamps(db, "15m")).toContain(DAY_START + 10 * 900);
  });

  it("a late open-shift calendar row cannot make a day-refill destroy bars cached under the old geometry", () => {
    const db = memDb();
    // Full day cached under template geometry (18:00 ET open).
    ingestCandles("NQ", "15m", bars15m(1, 92), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    // A manual open-shift row lands AFTER caching, misaligned with the 15m
    // lattice (18:20 → delta 1200s, 1200 % 900 !== 0): every old stamp is
    // now off the shifted grid.
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, open_time, source)
       VALUES ('cme_us_index_futures_eth', '2026-05-01', 'modified', '18:20', 'manual')`,
    ).run();
    // One stray bar of that day re-arrives via day-refill.
    ingestCandles("NQ", "15m", bars15m(92, 92), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    // Bars cached under the old anchor must survive (loud extras, never deleted).
    expect(stamps(db, "15m")).toHaveLength(92);
  });

  it("purges a pathologically junk-heavy day without hitting SQLite's bind cap", () => {
    const db = memDb();
    // ~32,890 off-grid 5m rows — an IN (?,...) delete with one bind per row
    // would exceed SQLITE_MAX_VARIABLE_NUMBER (32766) and abort the ingest.
    const ins = db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ','5m',?,1,2,0.5,1.5,10)`,
    );
    db.transaction(() => {
      for (let i = 1; i <= 33_000; i++) if (i % 300 !== 0) ins.run(DAY_START + i);
    })();
    ingestCandles("NQ", "5m", bars5m(1, 276), db, { mode: "day-refill", nowUnix: AFTER_CLOSE });
    expect(validateSessionDay(db, "NQ", SD, "5m", AFTER_CLOSE).status).toBe("ok");
  });

  it("screens an off-grid bar carried by the refill itself: the day still converges", () => {
    const db = memDb();
    // The refill payload ITSELF carries the mis-stamped extra — without
    // screening, purge-then-insert re-plants it on every refetch, forever.
    ingestCandles(
      "NQ", "5m",
      [...bars5m(1, 276), { timestamp: DAY_START + 450, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      db,
      { mode: "day-refill", nowUnix: AFTER_CLOSE },
    );
    expect(stamps(db, "5m")).not.toContain(DAY_START + 450);
    expect(validateSessionDay(db, "NQ", SD, "5m", AFTER_CLOSE).status).toBe("ok");
  });

  it("neither purges nor screens a declared-but-untimed early-close day (geometry unknown)", () => {
    const db = memDb();
    // Declared modified, no close time recorded yet: the day's true grid is
    // unknown until observeEarlyClose sees the trimmed series. Screening or
    // purging against the template grid would delete the genuine stub bar
    // and let a wrong (grid-truncated) close be recorded.
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source)
       VALUES ('cme_us_index_futures_eth', '2026-05-01', 'modified', 'nt8')`,
    ).run();
    // Trimmed session whose real close is NOT on the 15m template grid:
    // bars 1..74 plus a 12:37-style stub 7 minutes past the last full bar.
    const stub = DAY_START + 74 * 900 + 420;
    ingestCandles(
      "NQ", "15m",
      [...bars15m(1, 74), { timestamp: stub, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }],
      db,
      { mode: "day-refill", nowUnix: AFTER_CLOSE },
    );
    expect(stamps(db, "15m")).toContain(stub);
    expect(stamps(db, "15m")).toHaveLength(75);
  });

  it("spares the stub on a modified day with an open override but an unknown close", () => {
    const db = memDb();
    // Open side overridden (the Good-Friday '24:00' practice), close side
    // unknown: observeEarlyClose categorically refuses openTime days, so if
    // the purge/screen ran here against the template close, a genuine
    // off-grid early-close stub would be destroyed with no recording path.
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, open_time, source)
       VALUES ('cme_us_index_futures_eth', '2026-05-01', 'modified', '24:00', 'manual')`,
    ).run();
    // Bars within the shifted (midnight-open) window plus a 12:37-style stub.
    const stub = DAY_START + 74 * 900 + 420;
    ingestCandles(
      "NQ", "15m",
      [...bars15m(25, 74), { timestamp: stub, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }],
      db,
      { mode: "day-refill", nowUnix: AFTER_CLOSE },
    );
    expect(stamps(db, "15m")).toContain(stub);
    expect(stamps(db, "15m")).toHaveLength(51);
  });

  it("reports dropped rows: invalid and out-of-session bars are counted, not silent", () => {
    const db = memDb();
    const result = ingestCandles(
      "NQ", "15m",
      // Two good bars plus one stamped in the post-close gap (Fri 17:30 ET).
      [...bars15m(1, 2), { timestamp: DAY_END + 1800, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }],
      db,
      { mode: "day-refill", nowUnix: AFTER_CLOSE },
    );
    expect(result.inserted).toBe(2);
    expect(result.dropped).toBe(1);
  });
});
