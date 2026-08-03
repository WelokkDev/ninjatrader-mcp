import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import {
  normalizeDailyStamps,
  reconcileDailyAgainstIntraday,
  summarizeConventions,
} from "../daily.js";
import {
  expectedBarCount,
  expectedCloseStamps,
  validateSessionDay,
} from "../validator.js";
import { expectedRawGrid } from "../purge.js";
import { classifySessionDay } from "../fill.js";
import { ingestCandles } from "../../../bridge/ingest.js";
import { CME_US_INDEX_FUTURES_ETH } from "../../sessions/templates.js";
import { makeSessionDayResolver } from "../../sessions/session-day.js";
import type { Candle } from "../../types.js";

const unix = (y: number, mo1: number, d: number, h: number, mi = 0): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, mi, 0) / 1000);

// CME ETH session-day 2026-05-04 (EDT): Sun 18:00 ET → Mon 17:00 ET,
// i.e. 2026-05-03 22:00 UTC → 2026-05-04 21:00 UTC. 23h.
const D1 = { label: "2026-05-04", startUnix: unix(2026, 5, 3, 22), endUnix: unix(2026, 5, 4, 21) };
const D2 = { label: "2026-05-05", startUnix: unix(2026, 5, 4, 22), endUnix: unix(2026, 5, 5, 21) };
const NOW = unix(2026, 6, 1, 0);

function memDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

const resolver = () => makeSessionDayResolver(CME_US_INDEX_FUTURES_ETH);

function bar(timestamp: number, over: Partial<Candle> = {}): Candle {
  return { timestamp, open: 100, high: 110, low: 90, close: 105, volume: 1000, ...over };
}

// ── geometry ─────────────────────────────────────────────────────────────────

describe("1d cache geometry", () => {
  it("expects exactly one bar per session-day, stamped at the close", () => {
    expect(expectedBarCount(D1, "1d")).toBe(1);
    expect(expectedCloseStamps(D1, "1d")).toEqual([D1.endUnix]);
  });

  it("follows an early close without special-casing", () => {
    const early = { ...D1, endUnix: unix(2026, 5, 4, 17) };
    expect(expectedCloseStamps(early, "1d")).toEqual([early.endUnix]);
  });

  it("validates a day holding its single close-stamped bar", () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume) VALUES ('NQ','1d',?,1,2,0.5,1.5,10)`,
    ).run(D1.endUnix);
    expect(validateSessionDay(db, "NQ", D1, "1d", NOW).status).toBe("ok");
    expect(classifySessionDay(db, "NQ", D1, "1d", NOW)).toBe("complete");
  });

  it("flags an empty day and a day whose bar sits off the close stamp", () => {
    const db = memDb();
    expect(classifySessionDay(db, "NQ", D1, "1d", NOW)).toBe("empty");

    // Mid-session stamp — the shape a non-normalized ingest would leave.
    db.prepare(`INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume) VALUES ('NQ','1d',?,1,2,0.5,1.5,10)`).run(
      D1.startUnix + 3600,
    );
    const r = validateSessionDay(db, "NQ", D1, "1d", NOW);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual([D1.endUnix]);
    expect(r.extra).toEqual([D1.startUnix + 3600]);
  });

  it("skips an in-progress day rather than calling it incomplete", () => {
    const db = memDb();
    const nowMidSession = D1.endUnix - 3600;
    expect(validateSessionDay(db, "NQ", D1, "1d", nowMidSession).status).toBe("skipped");
  });

  it("puts only the close stamp on the purge grid", () => {
    expect([...expectedRawGrid(D1, "1d", CME_US_INDEX_FUTURES_ETH)]).toEqual([D1.endUnix]);
  });
});

// ── stamp normalization ──────────────────────────────────────────────────────

describe("normalizeDailyStamps", () => {
  it("leaves a session-close stamp alone", () => {
    const { bars, unresolved } = normalizeDailyStamps([bar(D1.endUnix)], resolver());
    expect(unresolved).toEqual([]);
    expect(bars[0].candle.timestamp).toBe(D1.endUnix);
    expect(bars[0].day.label).toBe("2026-05-04");
    expect(bars[0].convention).toBe("session_close");
  });

  it("re-stamps a trading-date-midnight bar onto its session close", () => {
    // 2026-05-04 00:00 ET = 04:00 UTC, inside the session that closes that day.
    const midnightET = unix(2026, 5, 4, 4);
    const { bars } = normalizeDailyStamps([bar(midnightET)], resolver());
    expect(bars[0].day.label).toBe("2026-05-04");
    expect(bars[0].candle.timestamp).toBe(D1.endUnix);
    expect(bars[0].sourceTimestamp).toBe(midnightET);
    expect(bars[0].convention).toBe("in_session");
  });

  it("resolves a stamp landing exactly on the session OPEN via the +1s probe", () => {
    // (startUnix, endUnix] excludes the open instant; without the probe this
    // daily bar would be dropped as out-of-session.
    const { bars, unresolved } = normalizeDailyStamps([bar(D1.startUnix)], resolver());
    expect(unresolved).toEqual([]);
    expect(bars[0].day.label).toBe("2026-05-04");
    expect(bars[0].candle.timestamp).toBe(D1.endUnix);
    expect(bars[0].convention).toBe("session_open");
  });

  it("reports a stamp in no session-day instead of guessing a day", () => {
    // Saturday noon ET — no CME ETH session.
    const saturday = unix(2026, 5, 9, 16);
    const { bars, unresolved } = normalizeDailyStamps([bar(saturday)], resolver());
    expect(bars).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });

  it("preserves OHLCV untouched while re-stamping", () => {
    const src = bar(unix(2026, 5, 4, 4), { open: 21000.25, high: 21100, low: 20900.5, close: 21050, volume: 42 });
    const { bars } = normalizeDailyStamps([src], resolver());
    expect(bars[0].candle).toEqual({ ...src, timestamp: D1.endUnix });
  });

  it("summarizes the observed conventions for the ingest log", () => {
    const { bars } = normalizeDailyStamps(
      [bar(D1.endUnix), bar(D2.endUnix), bar(unix(2026, 5, 4, 4))],
      resolver(),
    );
    expect(summarizeConventions(bars)).toContain("session_close=2");
    expect(summarizeConventions(bars)).toContain("in_session=1");
  });
});

// ── reconciliation ───────────────────────────────────────────────────────────

// A full 23h session-day of 15m bars (92 stamps) with a known OHLC envelope.
function seed15m(db: Database.Database, day: typeof D1): void {
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ','15m',?,?,?,?,?,10)`,
  );
  for (let i = 1; i <= 92; i++) {
    const isFirst = i === 1;
    const isLast = i === 92;
    stmt.run(
      day.startUnix + i * 900,
      isFirst ? 21000 : 21010, // session open only on the first bar
      isLast ? 21500 : 21100, // session high on the last bar
      isFirst ? 20800 : 20900, // session low on the first bar
      isLast ? 21400 : 21050, // session close on the last bar
    );
  }
}

describe("reconcileDailyAgainstIntraday", () => {
  it("passes when the daily bar matches the day's own intraday OHLC", () => {
    const db = memDb();
    seed15m(db, D1);
    const r = reconcileDailyAgainstIntraday(
      db, "NQ", D1,
      bar(D1.endUnix, { open: 21000, high: 21500, low: 20800, close: 21400 }),
      NOW,
    );
    expect(r.against).toBe("15m");
    expect(r.mismatches).toEqual([]);
  });

  it("catches a daily bar filed against the WRONG session-day", () => {
    const db = memDb();
    seed15m(db, D1);
    // D2's daily bar (different prices) mistakenly checked against D1's bars:
    // this is exactly the shape an off-by-one stamp convention would produce.
    const r = reconcileDailyAgainstIntraday(
      db, "NQ", D1,
      bar(D1.endUnix, { open: 22000, high: 22500, low: 21800, close: 22400 }),
      NOW,
    );
    expect(r.against).toBe("15m");
    expect(r.mismatches.map((m) => m.field).sort()).toEqual(["close", "high", "low", "open"]);
  });

  it("singles out an open-only disagreement", () => {
    const db = memDb();
    seed15m(db, D1);
    const r = reconcileDailyAgainstIntraday(
      db, "NQ", D1,
      bar(D1.endUnix, { open: 20999, high: 21500, low: 20800, close: 21400 }),
      NOW,
    );
    expect(r.mismatches).toEqual([{ field: "open", daily: 20999, intraday: 21000 }]);
  });

  it("stays silent when no intraday TF is completely cached", () => {
    const db = memDb();
    const r = reconcileDailyAgainstIntraday(db, "NQ", D1, bar(D1.endUnix), NOW);
    expect(r.against).toBeNull();
    expect(r.mismatches).toEqual([]);
  });

  it("does not check an in-progress session-day", () => {
    const db = memDb();
    seed15m(db, D1);
    const r = reconcileDailyAgainstIntraday(db, "NQ", D1, bar(D1.endUnix), D1.endUnix - 60);
    expect(r.against).toBeNull();
  });
});

// ── ingest wiring ────────────────────────────────────────────────────────────

describe("ingestCandles at 1d", () => {
  it("stores the re-stamped bar and reconciles it clean", () => {
    const db = memDb();
    seed15m(db, D1);
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    // NT8 hands over a trading-date-midnight stamp.
    const res = ingestCandles(
      "NQ", "1d",
      [bar(unix(2026, 5, 4, 4), { open: 21000, high: 21500, low: 20800, close: 21400 })],
      db,
      { mode: "day-refill", nowUnix: NOW },
    );
    errs.mockRestore();

    expect(res.inserted).toBe(1);
    expect(res.dailyMismatches).toBeUndefined();
    const rows = db
      .prepare(`SELECT timestamp, open FROM candles WHERE timeframe = '1d'`)
      .all() as Array<{ timestamp: number; open: number }>;
    expect(rows).toEqual([{ timestamp: D1.endUnix, open: 21000 }]);
    expect(validateSessionDay(db, "NQ", D1, "1d", NOW).status).toBe("ok");
  });

  it("reports a mismatch instead of silently trusting a mis-filed day", () => {
    const db = memDb();
    seed15m(db, D1);
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = ingestCandles(
      "NQ", "1d",
      [bar(D1.endUnix, { open: 22000, high: 22500, low: 21800, close: 22400 })],
      db,
      { mode: "day-refill", nowUnix: NOW },
    );
    const logged = errs.mock.calls.map((c) => String(c[0])).join("\n");
    errs.mockRestore();

    expect(res.inserted).toBe(1); // written, but loudly flagged
    expect(res.dailyMismatches).toHaveLength(1);
    expect(res.dailyMismatches![0].day).toBe("2026-05-04");
    expect(logged).toContain("1d RECONCILE FAILED");
  });

  it("does not fan a daily bar into the derived 30m–4h chain", () => {
    const db = memDb();
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = ingestCandles("NQ", "1d", [bar(D1.endUnix)], db, { nowUnix: NOW });
    errs.mockRestore();
    expect(Object.values(res.aggregated).every((n) => n === 0)).toBe(true);
    const derived = db
      .prepare(`SELECT COUNT(*) AS c FROM candles WHERE timeframe IN ('30m','1h','2h','4h')`)
      .get() as { c: number };
    expect(derived.c).toBe(0);
  });

  it("drops a daily bar that belongs to no session-day", () => {
    const db = memDb();
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = ingestCandles("NQ", "1d", [bar(unix(2026, 5, 9, 16))], db, { nowUnix: NOW });
    errs.mockRestore();
    expect(res.inserted).toBe(0);
    expect(res.dropped).toBe(1);
  });

  it("converges a day-refill onto the single close stamp", () => {
    const db = memDb();
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    // A stale off-grid daily row from an earlier geometry.
    db.prepare(`INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume) VALUES ('NQ','1d',?,1,2,0.5,1.5,10)`).run(
      D1.startUnix + 7200,
    );
    ingestCandles("NQ", "1d", [bar(D1.endUnix)], db, { mode: "day-refill", nowUnix: NOW });
    errs.mockRestore();
    const stamps = (
      db.prepare(`SELECT timestamp FROM candles WHERE timeframe='1d' ORDER BY timestamp`).all() as Array<{
        timestamp: number;
      }>
    ).map((r) => r.timestamp);
    expect(stamps).toEqual([D1.endUnix]);
  });
});
