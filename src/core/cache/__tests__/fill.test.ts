import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import {
  CANDLE_FETCH_TIMEOUT_MS,
  classifySessionDay,
  DAILY_FETCH_BATCH_DAYS,
  ensureCached,
  planFetchWindows,
  type DayClassification,
  type EnsureCachedDeps,
} from "../fill.js";
import { expectedCloseStamps } from "../validator.js";
import { CME_FX_FUTURES_ETH, CME_US_INDEX_FUTURES_ETH } from "../../sessions/templates.js";
import type { Timeframe } from "../../types.js";

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
      { startUnix: DAYS[0].startUnix, endUnix: DAYS[0].endUnix, days: [DAYS[0]], labels: ["2026-05-04"] },
      { startUnix: DAYS[1].startUnix, endUnix: DAYS[1].endUnix, days: [DAYS[1]], labels: ["2026-05-05"] },
      { startUnix: DAYS[2].startUnix, endUnix: DAYS[2].endUnix, days: [DAYS[2]], labels: ["2026-05-06"] },
    ]);
  });

  it("skips complete days entirely", () => {
    const windows = planFetchWindows(classify(["empty", "complete", "in_progress"]));
    expect(windows.map((w) => w.labels)).toEqual([["2026-05-04"], ["2026-05-06"]]);
  });

  it("keeps per-day windows for every intraday TF", () => {
    for (const tf of ["15s", "5m", "15m", "30m", "1h"] as const) {
      const windows = planFetchWindows(classify(["empty", "empty", "partial"]), tf);
      expect(windows.map((w) => w.labels)).toEqual([
        ["2026-05-04"],
        ["2026-05-05"],
        ["2026-05-06"],
      ]);
    }
  });
});

describe("planFetchWindows at 1d (batched)", () => {
  it("collapses the pending days into ONE window — a session-day is one daily bar", () => {
    const windows = planFetchWindows(classify(["empty", "empty", "partial"]), "1d");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      startUnix: DAYS[0].startUnix,
      endUnix: DAYS[2].endUnix,
      days: DAYS,
      labels: ["2026-05-04", "2026-05-05", "2026-05-06"],
    });
  });

  it("bridges over an already-complete day rather than splitting the request", () => {
    const windows = planFetchWindows(classify(["empty", "complete", "empty"]), "1d");
    expect(windows).toHaveLength(1);
    // The complete day is not re-listed as work, but the span covers it.
    expect(windows[0].labels).toEqual(["2026-05-04", "2026-05-06"]);
    expect(windows[0].endUnix).toBe(DAYS[2].endUnix);
  });

  it("chunks at DAILY_FETCH_BATCH_DAYS", () => {
    const many: DayClassification[] = Array.from({ length: 250 }, (_, i) => ({
      day: {
        label: `d${i}`,
        startUnix: 1_000_000 + i * 86_400,
        endUnix: 1_000_000 + i * 86_400 + 82_800,
      },
      class: "empty" as const,
    }));
    const windows = planFetchWindows(many, "1d");
    expect(windows.map((w) => w.days.length)).toEqual([
      DAILY_FETCH_BATCH_DAYS,
      DAILY_FETCH_BATCH_DAYS,
      10,
    ]);
    // 250 daily bars in 3 round-trips, not 250.
    expect(windows).toHaveLength(3);
  });

  it("emits nothing when every day is already complete", () => {
    expect(planFetchWindows(classify(["complete", "complete", "complete"]), "1d")).toEqual([]);
  });
});

describe("ensureCached fetch loop", () => {
  function harness(request: EnsureCachedDeps["request"], timeframe: Timeframe = "5m") {
    const db = new Database(":memory:");
    initializeSchema(db);
    return () =>
      ensureCached(
        db,
        "NQ",
        DAYS[0].startUnix,
        DAYS[2].endUnix,
        timeframe,
        CME_US_INDEX_FUTURES_ETH,
        { isConnected: () => true, request },
        NOW,
      );
  }

  it("fetches three cold daily days in ONE request spanning all of them", async () => {
    const request = vi.fn(
      async (_type: string, _payload: Record<string, unknown>, _timeoutMs?: number) => ({}),
    );
    const result = await harness(request, "1d")();
    expect(request).toHaveBeenCalledTimes(1);
    const payload = request.mock.calls[0][1];
    expect(payload.timeframe).toBe("1d");
    expect(payload.from).toBe(DAYS[0].startUnix);
    expect(payload.to).toBe(DAYS[2].endUnix);
    // All three days are still credited to the window.
    expect(result.fetchedDays).toEqual(["2026-05-04", "2026-05-05", "2026-05-06"]);
  });

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

  describe("the daily bar a day is verified against", () => {
    // NT8 for a thin symbol: four empty 15m buckets, and a 1d bar of the same volume.
    function thinFake(db: Database.Database) {
      const bar = db.prepare(
        `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
         VALUES ('M6E', ?, ?, 1, 2, 0.5, 1.5, ?)`,
      );
      return vi.fn(async (_type: string, payload: Record<string, unknown>) => {
        const from = payload.from as number;
        const to = payload.to as number;
        if (payload.timeframe === "1d") {
          for (const d of DAYS) if (d.endUnix > from && d.endUnix <= to) bar.run("1d", d.endUnix, 880);
        } else {
          expectedCloseStamps({ startUnix: from, endUnix: to }, "15m").forEach((t, i) => {
            if (![0, 1, 2, 40].includes(i)) bar.run("15m", t, 10);
          });
        }
        return {};
      });
    }
    const fetchThinDay = (db: Database.Database, request: EnsureCachedDeps["request"]) =>
      ensureCached(
        db, "M6E", DAYS[0].startUnix, DAYS[0].endUnix, "15m", CME_FX_FUTURES_ETH,
        { isConnected: () => true, request }, NOW,
      );
    const timeframesOf = (request: ReturnType<typeof thinFake>) =>
      request.mock.calls.map((c) => c[1].timeframe);

    it("is fetched after the day's own bars", async () => {
      const db = new Database(":memory:");
      initializeSchema(db);
      const request = thinFake(db);
      await fetchThinDay(db, request);
      expect(timeframesOf(request)).toEqual(["15m", "1d"]);
      expect(classifySessionDay(db, "M6E", DAYS[0], "15m", NOW)).toBe("complete");
    });

    it("settles a cached day that only lacked it, without refetching the day", async () => {
      const db = new Database(":memory:");
      initializeSchema(db);
      const request = thinFake(db);
      await request("request_candles", {
        timeframe: "15m", from: DAYS[0].startUnix, to: DAYS[0].endUnix,
      });
      request.mockClear();
      const result = await fetchThinDay(db, request);
      expect(timeframesOf(request)).toEqual(["1d"]);
      expect(result.classifications[0].class).toBe("complete");
    });

    it("is never requested for an imported day", async () => {
      const db = new Database(":memory:");
      initializeSchema(db);
      const request = thinFake(db);
      await request("request_candles", {
        timeframe: "15m", from: DAYS[0].startUnix, to: DAYS[0].endUnix,
      });
      db.prepare(`UPDATE candles SET source = 'databento' WHERE symbol = 'M6E'`).run();
      request.mockClear();
      await fetchThinDay(db, request);
      expect(request).not.toHaveBeenCalled();
    });

    it("is never requested for an instrument judged by its bars", async () => {
      const request = vi.fn(async (_type: string, _payload: Record<string, unknown>) => ({}));
      await harness(request)();
      expect(request.mock.calls.map((c) => c[1].timeframe)).toEqual(["5m", "5m", "5m"]);
    });
  });

  it("post-fetch reconcile spares a declared-but-untimed early-close day whose close could not be recorded", async () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    // 2026-05-04 declared modified, no time known.
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source)
       VALUES ('cme_us_index_futures_eth', '2026-05-04', 'modified', 'nt8')`,
    ).run();
    // The fetch "heals" a trimmed series ending in a stub off the template
    // grid. With the close time unknown, the purge must not delete the
    // genuine stub against template geometry.
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

  it("never reclassifies an imported day, however broken its geometry", () => {
    // A 3-minute hole — would classify "partial" and trigger a refetch.
    const all = expectedCloseStamps(DAYS[0], "15s");
    const hole = all.slice(2000, 2012);

    for (const [source, expected] of [
      ["databento", "complete"],
      ["nt8", "partial"],
      [null, "partial"], // predates the column
    ] as const) {
      const db = new Database(":memory:");
      initializeSchema(db);
      seed15s(db, DAYS[0], hole);
      db.prepare(`UPDATE candles SET source = ? WHERE symbol = 'NQ'`).run(source);
      expect(classifySessionDay(db, "NQ", DAYS[0], "15s", NOW), `source=${source}`).toBe(expected);
    }
  });

  it("plans no fetch window over an imported day, so nothing overwrites it", async () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    seed15s(db, DAYS[0], expectedCloseStamps(DAYS[0], "15s").slice(2000, 2012));
    db.prepare(`UPDATE candles SET source = 'databento' WHERE symbol = 'NQ'`).run();

    const request = vi.fn();
    const result = await ensureCached(
      db,
      "NQ",
      DAYS[0].startUnix,
      DAYS[0].endUnix,
      "15s",
      CME_US_INDEX_FUTURES_ETH,
      { isConnected: () => true, request },
      NOW,
    );
    expect(request).not.toHaveBeenCalled();
    expect(result.classifications.map((c) => c.class)).toEqual(["complete"]);
  });

  it("still treats an in-progress day as in_progress even if rows are imported", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    seed15s(db, DAYS[0], []);
    db.prepare(`UPDATE candles SET source = 'databento' WHERE symbol = 'NQ'`).run();
    // now < endUnix: the live stream owns today, so the guard must not fire.
    const during = DAYS[0].endUnix - 3600;
    expect(classifySessionDay(db, "NQ", DAYS[0], "15s", during)).toBe("in_progress");
  });
});
