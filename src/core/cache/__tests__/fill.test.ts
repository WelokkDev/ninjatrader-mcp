import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import {
  CANDLE_FETCH_TIMEOUT_MS,
  classifySessionDay,
  ensureCached,
  observeEarlyClose,
  planFetchWindows,
  type DayClassification,
  type EnsureCachedDeps,
} from "../fill.js";
import { expectedCloseStamps } from "../validator.js";
import { CME_US_INDEX_FUTURES_ETH } from "../../sessions/templates.js";
import type { SessionCalendar } from "../../sessions/calendar.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// Mon 2026-05-04 .. Wed 2026-05-06 session-days (EDT):
const DAYS = [
  { label: "2026-05-04", startUnix: unix(2026, 5, 3, 22), endUnix: unix(2026, 5, 4, 21) },
  { label: "2026-05-05", startUnix: unix(2026, 5, 4, 22), endUnix: unix(2026, 5, 5, 21) },
  { label: "2026-05-06", startUnix: unix(2026, 5, 5, 22), endUnix: unix(2026, 5, 6, 21) },
];

// A "now" long after the range so no day classifies in_progress.
const NOW = unix(2026, 6, 1, 0);

function classify(classes: Array<DayClassification["class"]>): DayClassification[] {
  return classes.map((cls, i) => ({ day: DAYS[i], class: cls }));
}

describe("planFetchWindows (per-day, no merging)", () => {
  it("emits one window per non-complete day", () => {
    const windows = planFetchWindows(classify(["empty", "empty", "partial"]));
    expect(windows).toEqual([
      { startUnix: DAYS[0].startUnix, endUnix: DAYS[0].endUnix, labels: ["2026-05-04"] },
      { startUnix: DAYS[1].startUnix, endUnix: DAYS[1].endUnix, labels: ["2026-05-05"] },
      { startUnix: DAYS[2].startUnix, endUnix: DAYS[2].endUnix, labels: ["2026-05-06"] },
    ]);
  });

  it("skips complete days entirely", () => {
    const windows = planFetchWindows(classify(["empty", "complete", "in_progress"]));
    expect(windows.map((w) => w.labels)).toEqual([["2026-05-04"], ["2026-05-06"]]);
  });
});

describe("ensureCached fetch loop", () => {
  function harness(request: EnsureCachedDeps["request"]) {
    const db = new Database(":memory:");
    initializeSchema(db);
    return () =>
      ensureCached(
        db,
        "NQ",
        DAYS[0].startUnix,
        DAYS[2].endUnix,
        "5m",
        CME_US_INDEX_FUTURES_ETH,
        { isConnected: () => true, request },
        NOW,
      );
  }

  it("threads the scaled candle-fetch timeout into every request", async () => {
    const request = vi.fn(
      async (_type: string, _payload: Record<string, unknown>, _timeoutMs?: number) => ({}),
    );
    const result = await harness(request)();
    expect(result.windowsFetched).toBe(3);
    expect(request).toHaveBeenCalledTimes(3);
    for (const call of request.mock.calls) {
      expect(call[0]).toBe("request_candles");
      expect(call[2]).toBe(CANDLE_FETCH_TIMEOUT_MS);
    }
  });

  it("treats the response as a pure success signal — no body inspection, no ingest", async () => {
    // Resolves with a body that has no `candles` at all; ingest ownership
    // moved to the global candles_response handler.
    const request = vi.fn(async () => undefined);
    const result = await harness(request)();
    expect(result.windowsFetched).toBe(3);
    expect(result.windowsFailed).toBe(0);
    expect(result.fetchedDays).toEqual(["2026-05-04", "2026-05-05", "2026-05-06"]);
  });

  it("fails one slow day in isolation while the others succeed", async () => {
    const request = vi.fn(async (_type: string, payload: Record<string, unknown>) => {
      if (payload.from === DAYS[1].startUnix) throw new Error("boom");
      return {};
    });
    const result = await harness(request)();
    expect(result.windowsFetched).toBe(2);
    expect(result.windowsFailed).toBe(1);
    expect(result.errors).toEqual([{ window: "2026-05-05", message: "boom" }]);
    expect(result.fetchedDays).toEqual(["2026-05-04", "2026-05-06"]);
  });

  it("post-fetch reconcile spares a declared-but-untimed early-close day whose close could not be recorded", async () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    // 2026-05-04 declared modified, no time known.
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source)
       VALUES ('cme_us_index_futures_eth', '2026-05-04', 'modified', 'nt8')`,
    ).run();
    // The fetch "heals" a trimmed series with a GAP in the prefix (bar 3
    // missing) and a stub off the template grid: observeEarlyClose refuses
    // the gap-riddled prefix, so no close is recorded — the purge must not
    // then delete the genuine stub against template geometry.
    const stub = DAYS[0].startUnix + 74 * 900 + 420;
    const ins = db.prepare(
      `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '15m', ?, 1, 2, 0.5, 1.5, 10)`,
    );
    const request = vi.fn(async () => {
      for (let i = 1; i <= 74; i++) if (i !== 3) ins.run(DAYS[0].startUnix + i * 900);
      ins.run(stub);
      return {};
    });
    const { loadCalendar } = await import("../../sessions/calendar.js");
    await ensureCached(
      db,
      "NQ",
      DAYS[0].startUnix,
      DAYS[0].endUnix,
      "15m",
      CME_US_INDEX_FUTURES_ETH,
      { isConnected: () => true, request },
      NOW,
      loadCalendar(db, "cme_us_index_futures_eth"),
    );
    const stamps = (
      db
        .prepare(`SELECT timestamp FROM candles WHERE symbol='NQ' AND timeframe='15m'`)
        .all() as Array<{ timestamp: number }>
    ).map((r) => r.timestamp);
    expect(stamps).toContain(stub);
  });
});

describe("sparse 15s days through classify and early-close observation", () => {
  function seed15s(
    db: Database.Database,
    window: { startUnix: number; endUnix: number },
    omit: readonly number[] = [],
  ): void {
    const skip = new Set(omit);
    const stmt = db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '15s', ?, 1, 2, 0.5, 1.5, 10)`,
    );
    db.transaction(() => {
      for (const t of expectedCloseStamps(window, "15s")) {
        if (!skip.has(t)) stmt.run(t);
      }
    })();
  }

  it("classifies a scattered-sparse closed 15s day as complete, a gapped one as partial", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    const all = expectedCloseStamps(DAYS[0], "15s");
    seed15s(db, DAYS[0], all.filter((_, i) => i % 200 === 199)); // 27 isolated
    expect(classifySessionDay(db, "NQ", DAYS[0], "15s", NOW)).toBe("complete");
    const gapped = new Database(":memory:");
    initializeSchema(gapped);
    seed15s(gapped, DAYS[0], all.slice(2000, 2012)); // 3-minute hole
    expect(classifySessionDay(gapped, "NQ", DAYS[0], "15s", NOW)).toBe("partial");
  });

  it("records an observed early close over a sparse 15s prefix", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source)
       VALUES ('cme_us_index_futures_eth', '2026-05-04', 'modified', 'nt8')`,
    ).run();
    // Bars end at a 13:00 ET early close (4h before template close), with
    // scattered zero-tick gaps in the prefix — the Juneteenth shape.
    const earlyClose = DAYS[0].endUnix - 4 * 3600;
    const prefix = { startUnix: DAYS[0].startUnix, endUnix: earlyClose };
    const all = expectedCloseStamps(prefix, "15s");
    seed15s(db, prefix, all.filter((_, i) => i % 150 === 149 && i < all.length - 1));
    const cal: SessionCalendar = new Map([
      ["2026-05-04", { date: "2026-05-04", kind: "modified" as const, source: "nt8" as const }],
    ]);
    expect(observeEarlyClose(db, "NQ", "15s", DAYS[0], CME_US_INDEX_FUTURES_ETH, cal, NOW)).toBe(true);
    const row = db
      .prepare(`SELECT close_time, source FROM session_calendar WHERE date = '2026-05-04'`)
      .get() as { close_time: string; source: string };
    expect(row.close_time).toBe("13:00");
    expect(row.source).toBe("nt8-observed");
    // Under the adjusted geometry the sparse day now classifies complete.
    expect(
      classifySessionDay(db, "NQ", { label: "2026-05-04", ...prefix }, "15s", NOW),
    ).toBe("complete");
  });
});
