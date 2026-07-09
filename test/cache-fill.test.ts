import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { initializeSchema } from "../src/db/schema.js";
import {
  classifySessionDay,
  planFetchWindows,
  ensureCached,
  type DayClassification,
} from "../src/core/cache/fill.js";
import { CME_US_INDEX_FUTURES_ETH } from "../src/core/sessions/templates.js";
import { loadCalendar } from "../src/core/sessions/calendar.js";
import { sessionDayRange } from "../src/core/sessions/session-day.js";
import type { SessionDay } from "../src/core/sessions/types.js";
import type { Timeframe } from "../src/core/types.js";

const NOW_FUTURE = 2_000_000_000;

function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function dayFor(label: string): SessionDay {
  const r = sessionDayRange(label, CME_US_INDEX_FUTURES_ETH);
  return { label, startUnix: r.startUnix, endUnix: r.endUnix };
}

function generateStamps(day: SessionDay, tf: Timeframe): number[] {
  const period: Record<Timeframe, number> = {
    "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
  };
  const p = period[tf];
  const dur = day.endUnix - day.startUnix;
  const full = Math.floor(dur / p);
  const stub = dur % p !== 0;
  const out: number[] = [];
  for (let i = 1; i <= full; i++) out.push(day.startUnix + i * p);
  if (stub) out.push(day.endUnix);
  return out;
}

function seedFull(db: DatabaseType, symbol: string, tf: Timeframe, day: SessionDay): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, 1, 1, 1, 1, 1)`,
  );
  for (const t of generateStamps(day, tf)) stmt.run(symbol, tf, t);
}

function seedPartial(db: DatabaseType, symbol: string, tf: Timeframe, day: SessionDay, keepEvery: number): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, 1, 1, 1, 1, 1)`,
  );
  const stamps = generateStamps(day, tf);
  for (let i = 0; i < stamps.length; i += keepEvery) stmt.run(symbol, tf, stamps[i]);
}

describe("classifySessionDay", () => {
  const day = dayFor("2026-05-01");

  it("complete: full session-day at the raw TF", () => {
    const db = makeDb();
    seedFull(db, "NQ", "15m", day);
    expect(classifySessionDay(db, "NQ", day, "15m", NOW_FUTURE)).toBe("complete");
  });

  it("empty: zero bars cached", () => {
    const db = makeDb();
    expect(classifySessionDay(db, "NQ", day, "15m", NOW_FUTURE)).toBe("empty");
  });

  it("partial: some bars cached but structurally incomplete", () => {
    const db = makeDb();
    seedPartial(db, "NQ", "15m", day, 4); // every 4th bar only
    expect(classifySessionDay(db, "NQ", day, "15m", NOW_FUTURE)).toBe("partial");
  });

  it("in_progress: session end is in the future", () => {
    const db = makeDb();
    const midSession = day.startUnix + 1000;
    expect(classifySessionDay(db, "NQ", day, "15m", midSession)).toBe("in_progress");
  });
});

describe("planFetchWindows", () => {
  const d1 = dayFor("2026-04-27");
  const d2 = dayFor("2026-04-28");
  const d3 = dayFor("2026-04-29");
  const d4 = dayFor("2026-04-30");
  const d5 = dayFor("2026-05-01");

  const c = (day: SessionDay, cls: DayClassification["class"]): DayClassification => ({ day, class: cls });

  it("all complete → no fetch windows", () => {
    const w = planFetchWindows([c(d1, "complete"), c(d2, "complete")]);
    expect(w).toEqual([]);
  });

  it("all empty → one window per day (per-day fetches, no merging)", () => {
    const w = planFetchWindows([c(d1, "empty"), c(d2, "empty"), c(d3, "empty")]);
    expect(w).toHaveLength(3);
    expect(w.map((x) => x.labels)).toEqual([[d1.label], [d2.label], [d3.label]]);
    expect(w[0].startUnix).toBe(d1.startUnix);
    expect(w[0].endUnix).toBe(d1.endUnix);
  });

  it("front gap only → one window per missing front day", () => {
    const w = planFetchWindows([c(d1, "empty"), c(d2, "empty"), c(d3, "complete"), c(d4, "complete")]);
    expect(w.map((x) => x.labels)).toEqual([[d1.label], [d2.label]]);
  });

  it("back gap only → one window per missing back day", () => {
    const w = planFetchWindows([c(d1, "complete"), c(d2, "complete"), c(d3, "empty"), c(d4, "empty")]);
    expect(w.map((x) => x.labels)).toEqual([[d3.label], [d4.label]]);
  });

  it("middle gap (complete around empty) → one window per gap day", () => {
    const w = planFetchWindows([c(d1, "complete"), c(d2, "empty"), c(d3, "empty"), c(d4, "complete")]);
    expect(w.map((x) => x.labels)).toEqual([[d2.label], [d3.label]]);
  });

  it("non-contiguous gaps → one window per missing day", () => {
    const w = planFetchWindows([
      c(d1, "empty"), c(d2, "complete"), c(d3, "complete"),
      c(d4, "empty"), c(d5, "empty"),
    ]);
    expect(w.map((x) => x.labels)).toEqual([[d1.label], [d4.label], [d5.label]]);
  });

  it("partial day → fetched (overwrites on re-ingest)", () => {
    const w = planFetchWindows([c(d1, "partial"), c(d2, "complete")]);
    expect(w).toHaveLength(1);
    expect(w[0].labels).toEqual([d1.label]);
  });

  it("in_progress day → always fetched", () => {
    const w = planFetchWindows([c(d1, "complete"), c(d2, "in_progress")]);
    expect(w).toHaveLength(1);
    expect(w[0].labels).toEqual([d2.label]);
  });

  it("empty input → no windows", () => {
    expect(planFetchWindows([])).toEqual([]);
  });
});

describe("ensureCached", () => {
  const d1 = dayFor("2026-04-27");
  const d2 = dayFor("2026-04-28");
  const d3 = dayFor("2026-04-29");

  it("no-op when every session-day in range is complete", async () => {
    const db = makeDb();
    seedFull(db, "NQ", "15m", d1);
    seedFull(db, "NQ", "15m", d2);
    seedFull(db, "NQ", "15m", d3);

    let requested = false;
    const result = await ensureCached(
      db, "NQ", d1.startUnix, d3.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async () => { requested = true; return { candles: [] }; },
      },
      NOW_FUTURE,
    );

    expect(requested).toBe(false);
    expect(result.windowsFetched).toBe(0);
    expect(result.windowsFailed).toBe(0);
    expect(result.classifications.every((c) => c.class === "complete")).toBe(true);
  });

  it("fetches each missing day when cache has a gap", async () => {
    const db = makeDb();
    seedFull(db, "NQ", "15m", d1);
    // d2 and d3 are empty

    const requests: Array<Record<string, unknown>> = [];
    const result = await ensureCached(
      db, "NQ", d1.startUnix, d3.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async (_type, payload) => {
          requests.push(payload as Record<string, unknown>);
          return { candles: [] };
        },
      },
      NOW_FUTURE,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].timeframe).toBe("15m");
    expect(requests[0].from).toBe(d2.startUnix);
    expect(requests[0].to).toBe(d2.endUnix);
    expect(requests[1].from).toBe(d3.startUnix);
    expect(requests[1].to).toBe(d3.endUnix);
    expect(requests[0].tradingHoursTemplate).toBe(CME_US_INDEX_FUTURES_ETH.name);
    expect(result.windowsFetched).toBe(2);
    expect(result.fetchedDays).toEqual([d2.label, d3.label]);
  });

  it("issues one request per non-contiguous gap (does not merge across complete days)", async () => {
    const db = makeDb();
    // d1 empty, d2 complete, d3 empty
    seedFull(db, "NQ", "15m", d2);

    const requests: Array<Record<string, unknown>> = [];
    await ensureCached(
      db, "NQ", d1.startUnix, d3.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async (_type, payload) => {
          requests.push(payload as Record<string, unknown>);
          return { candles: [] };
        },
      },
      NOW_FUTURE,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].from).toBe(d1.startUnix);
    expect(requests[0].to).toBe(d1.endUnix);
    expect(requests[1].from).toBe(d3.startUnix);
    expect(requests[1].to).toBe(d3.endUnix);
  });

  it("disconnected bridge → no requests, all windows reported as failed", async () => {
    const db = makeDb();
    let requested = false;
    const result = await ensureCached(
      db, "NQ", d1.startUnix, d2.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => false,
        request: async () => { requested = true; return { candles: [] }; },
      },
      NOW_FUTURE,
    );

    expect(requested).toBe(false);
    expect(result.bridgeDisconnected).toBe(true);
    expect(result.windowsFailed).toBeGreaterThan(0);
    expect(result.errors[0].message).toBe("NinjaTrader not connected");
  });

  it("in-progress day in range → always refetched even when other days are complete", async () => {
    const db = makeDb();
    seedFull(db, "NQ", "15m", d1);
    seedFull(db, "NQ", "15m", d2);
    seedFull(db, "NQ", "15m", d3);

    // Pretend "now" is mid-session of d3 so d3 is in_progress.
    const nowMidD3 = d3.startUnix + 100;

    const requests: Array<Record<string, unknown>> = [];
    await ensureCached(
      db, "NQ", d1.startUnix, d3.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async (_type, payload) => {
          requests.push(payload as Record<string, unknown>);
          return { candles: [] };
        },
      },
      nowMidD3,
    );

    // d3 should be the only fetched window
    expect(requests).toHaveLength(1);
    expect(requests[0].from).toBe(d3.startUnix);
    expect(requests[0].to).toBe(d3.endUnix);
  });

  it("partial day in range → fetches whole day (overwrites)", async () => {
    const db = makeDb();
    seedPartial(db, "NQ", "15m", d1, 4); // partial coverage

    const requests: Array<Record<string, unknown>> = [];
    await ensureCached(
      db, "NQ", d1.startUnix, d1.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async (_type, payload) => {
          requests.push(payload as Record<string, unknown>);
          return { candles: [] };
        },
      },
      NOW_FUTURE,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].from).toBe(d1.startUnix);
    expect(requests[0].to).toBe(d1.endUnix);
  });

  it("propagates request errors as windowsFailed (does not throw)", async () => {
    const db = makeDb();
    const result = await ensureCached(
      db, "NQ", d1.startUnix, d1.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async () => { throw new Error("bridge timeout"); },
      },
      NOW_FUTURE,
    );

    expect(result.windowsFetched).toBe(0);
    expect(result.windowsFailed).toBe(1);
    expect(result.errors[0].message).toBe("bridge timeout");
  });
});

describe("calendar-aware ensureCached (holidays + observed close)", () => {
  const d1 = dayFor("2026-05-04");
  const d2 = dayFor("2026-05-05");
  const d3 = dayFor("2026-05-06");
  const TPL = CME_US_INDEX_FUTURES_ETH.name;

  function calFor(db: DatabaseType) {
    // Fresh read of the session_calendar table (plus bootstrap seed).
    return loadCalendar(db, TPL);
  }

  it("closed days vanish from enumeration — never classified, never fetched", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source) VALUES (?, '2026-05-05', 'closed', 'nt8')`,
    ).run(TPL);
    seedFull(db, "NQ", "15m", d1);
    seedFull(db, "NQ", "15m", d3);

    const requests: unknown[] = [];
    const result = await ensureCached(
      db, "NQ", d1.startUnix, d3.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      { isConnected: () => true, request: async (_t, p) => { requests.push(p); return {}; } },
      NOW_FUTURE,
      calFor(db),
    );
    expect(requests).toHaveLength(0);
    expect(result.classifications.map((c) => c.day.label)).toEqual(["2026-05-04", "2026-05-06"]);
    expect(result.windowsFailed).toBe(0);
  });

  it("a declared early-close day with a recorded time classifies complete (refetch loop ends)", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, close_time, source) VALUES (?, '2026-05-05', 'modified', '13:00', 'nt8-observed')`,
    ).run(TPL);
    const cal = calFor(db);
    const adjusted = { label: "2026-05-05", ...sessionDayRange("2026-05-05", CME_US_INDEX_FUTURES_ETH, cal) };
    seedFull(db, "NQ", "15m", d1);
    seedFull(db, "NQ", "15m", adjusted); // 76 bars ending 13:00 EDT

    let requested = false;
    const result = await ensureCached(
      db, "NQ", d1.startUnix, adjusted.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      { isConnected: () => true, request: async () => { requested = true; return {}; } },
      NOW_FUTURE,
      cal,
    );
    expect(requested).toBe(false);
    expect(result.classifications.every((c) => c.class === "complete")).toBe(true);
  });

  it("re-classifies at execute time and skips days healed while queued", async () => {
    const db = makeDb();
    // Both days empty; the FIRST request heals BOTH days (simulating a
    // concurrent background job landing while this window waited its turn).
    let requests = 0;
    const result = await ensureCached(
      db, "NQ", d1.startUnix, d2.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async () => {
          requests++;
          seedFull(db, "NQ", "15m", d1);
          seedFull(db, "NQ", "15m", d2);
          return {};
        },
      },
      NOW_FUTURE,
    );
    expect(requests).toBe(1);
    expect(result.windowsFetched).toBe(2);
    expect(result.fetchedDays).toEqual([d1.label, d2.label]);
    expect(result.windowsFailed).toBe(0);
  });

  it("observed-close interlock records the close from a trimmed fetch of a declared untimed day", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source) VALUES (?, '2026-05-05', 'modified', 'nt8')`,
    ).run(TPL);
    const cal = calFor(db);
    // NT8 returns a clean 13:00-EDT-trimmed session (76 bars).
    const trimmedEnd = d2.startUnix + 76 * 900;
    const result = await ensureCached(
      db, "NQ", d2.startUnix, d2.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async () => {
          seedFull(db, "NQ", "15m", { ...d2, endUnix: trimmedEnd });
          return {};
        },
      },
      NOW_FUTURE,
      cal,
    );
    expect(result.calendarUpdated).toBe(true);
    const after = loadCalendar(db, TPL).get("2026-05-05");
    expect(after).toMatchObject({ closeTime: "13:00", source: "nt8-observed" });
  });

  it("interlock refuses a gap-riddled prefix and a normal-length day", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source) VALUES (?, '2026-05-04', 'modified', 'nt8')`,
    ).run(TPL);
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source) VALUES (?, '2026-05-05', 'modified', 'nt8')`,
    ).run(TPL);
    const cal = calFor(db);
    const trimmedEnd = d1.startUnix + 76 * 900;
    const result = await ensureCached(
      db, "NQ", d1.startUnix, d2.endUnix, "15m", CME_US_INDEX_FUTURES_ETH,
      {
        isConnected: () => true,
        request: async (_t, p) => {
          const from = (p as Record<string, unknown>).from;
          if (from === d1.startUnix) {
            // Trimmed prefix WITH an internal gap → must not be blessed.
            seedFull(db, "NQ", "15m", { ...d1, endUnix: trimmedEnd });
            db.prepare(`DELETE FROM candles WHERE symbol='NQ' AND timeframe='15m' AND timestamp = ?`).run(d1.startUnix + 10 * 900);
          } else {
            // Full normal session → observed close == template close → no write.
            seedFull(db, "NQ", "15m", d2);
          }
          return {};
        },
      },
      NOW_FUTURE,
      cal,
    );
    expect(result.calendarUpdated).toBe(false);
    const after = loadCalendar(db, TPL);
    expect(after.get("2026-05-04")!.closeTime).toBeUndefined();
    expect(after.get("2026-05-05")!.closeTime).toBeUndefined();
  });
});
