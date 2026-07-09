import { describe, it, expect } from "vitest";
import { aggregateCandles, type AggregateOptions } from "../src/core/aggregator.js";
import {
  CME_US_INDEX_FUTURES_ETH,
  CONTINUOUS_24_7,
} from "../src/core/sessions/templates.js";
import type { Candle } from "../src/core/types.js";

// DST-safe ET-instant helper. Computes the unix-second timestamp for a
// wall-clock instant in America/New_York, regardless of EST/EDT. Use this
// helper for any new test — the previous implementation hardcoded `-04:00`
// (EDT) and silently produced wrong timestamps for winter dates.
function et(yyyymmddhhmmss: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(yyyymmddhhmmss);
  if (!m) throw new Error(`bad ET instant: ${yyyymmddhhmmss}`);
  const [, y, mo, d, hh, mm, ss] = m;
  const probeMs = Date.UTC(+y, +mo - 1, +d, 12, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(probeMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const localAsUtcMs = Date.UTC(
    +get("year"), +get("month") - 1, +get("day"),
    +get("hour"), +get("minute"), +get("second"),
  );
  const offsetMs = localAsUtcMs - probeMs;
  return Math.floor(
    (Date.UTC(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0) - offsetMs) / 1000,
  );
}

function utc(yyyymmddhhmmss: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(yyyymmddhhmmss);
  if (!m) throw new Error(`bad UTC instant: ${yyyymmddhhmmss}`);
  const [, y, mo, d, hh, mm, ss] = m;
  return Math.floor(Date.UTC(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0) / 1000);
}

// 15m bar with close-stamp `etISO`. Volume = open for easy assertion.
function bar(etISO: string, ohlc: [number, number, number, number]): Candle {
  return {
    timestamp: et(etISO),
    open: ohlc[0],
    high: ohlc[1],
    low: ohlc[2],
    close: ohlc[3],
    volume: ohlc[0],
  };
}

function utcBar(utcISO: string, ohlc: [number, number, number, number]): Candle {
  return {
    timestamp: utc(utcISO),
    open: ohlc[0],
    high: ohlc[1],
    low: ohlc[2],
    close: ohlc[3],
    volume: ohlc[0],
  };
}

// Default options for CME-ETH tests. `now` is set well into the future
// so partial-bar marking never fires unless a test pins it.
const ETH_OPTS: AggregateOptions = {
  session: CME_US_INDEX_FUTURES_ETH,
  alignment: "session_aligned_with_stubs",
  timestampConvention: "close-stamped",
  now: utc("2099-01-01T00:00:00"),
};

const UTC_OPTS: AggregateOptions = {
  session: CONTINUOUS_24_7,
  alignment: "wall_clock_utc",
  timestampConvention: "close-stamped",
  now: utc("2099-01-01T00:00:00"),
};

describe("aggregateCandles — 15m passthrough", () => {
  it("returns a copy when target is 15m", () => {
    const input: Candle[] = [bar("2026-05-01T09:30:00", [1, 2, 0.5, 1.5])];
    const out = aggregateCandles(input, "15m", ETH_OPTS);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(input[0].timestamp);
    expect(out).not.toBe(input);
  });
});

describe("aggregateCandles — CME ETH 30m / 1h", () => {
  // For CME ETH, session-day Fri 2026-05-01 opens Thu 18:00 ET. So the
  // first 15m close-stamp inside that session is Thu 18:15 ET.
  // 09:30 / 09:45 ET on Fri are both inside the Fri session-day.

  it("aggregates two 15m bars into one 30m bar", () => {
    const input: Candle[] = [
      bar("2026-05-01T09:45:00", [100, 110, 95, 105]),
      bar("2026-05-01T10:00:00", [105, 120, 100, 115]),
    ];
    const out = aggregateCandles(input, "30m", ETH_OPTS);
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.open).toBe(100);
    expect(c.high).toBe(120);
    expect(c.low).toBe(95);
    expect(c.close).toBe(115);
    expect(c.volume).toBe(205);
    // Close-stamp = close-stamp of last underlying bar (NT8 convention).
    expect(c.timestamp).toBe(et("2026-05-01T10:00:00"));
  });

  it("aggregates four 15m bars into one 1h bar", () => {
    const input: Candle[] = [
      bar("2026-05-01T10:15:00", [100, 110, 95, 105]),
      bar("2026-05-01T10:30:00", [105, 115, 100, 110]),
      bar("2026-05-01T10:45:00", [110, 125, 108, 120]),
      bar("2026-05-01T11:00:00", [120, 130, 115, 128]),
    ];
    const out = aggregateCandles(input, "1h", ETH_OPTS);
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(100);
    expect(out[0].high).toBe(130);
    expect(out[0].low).toBe(95);
    expect(out[0].close).toBe(128);
    expect(out[0].timestamp).toBe(et("2026-05-01T11:00:00"));
  });
});

describe("aggregateCandles — never aggregates across session-day boundaries", () => {
  it("Tue session-close bars and Wed session-open bars stay in separate buckets", () => {
    // Tue session-day closes at Tue 17:00 ET. Wed session-day opens at
    // Tue 18:00 ET; first in-session bar is Tue 18:15 ET.
    const input: Candle[] = [
      bar("2026-05-05T16:45:00", [100, 105, 99, 102]), // last two bars of Tue session
      bar("2026-05-05T17:00:00", [102, 108, 100, 107]),
      bar("2026-05-05T18:15:00", [200, 210, 195, 205]), // first two bars of Wed session
      bar("2026-05-05T18:30:00", [205, 220, 200, 215]),
    ];
    const out = aggregateCandles(input, "30m", ETH_OPTS);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(107);
    expect(out[1].open).toBe(200);
    expect(out[1].close).toBe(215);
  });
});

describe("aggregateCandles — 4h is session-aligned (CME ETH)", () => {
  it("produces 6 buckets at 22:00, 02:00, 06:00, 10:00, 14:00, 17:00 (stub) for one Tue session-day", () => {
    // Build all 92 close-stamps for session-day Tue 2026-04-21
    // (Mon 18:15 ET → Tue 17:00 ET, 23 hours, 92 × 15min bars).
    const start = et("2026-04-20T18:00:00"); // session open instant
    const end = et("2026-04-21T17:00:00");   // last in-session close-stamp
    const input: Candle[] = [];
    for (let ts = start + 900; ts <= end; ts += 900) {
      input.push({ timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }

    const out = aggregateCandles(input, "4h", ETH_OPTS);
    const closeStamps = out.map((c) => c.timestamp);
    expect(closeStamps).toEqual([
      et("2026-04-20T22:00:00"),
      et("2026-04-21T02:00:00"),
      et("2026-04-21T06:00:00"),
      et("2026-04-21T10:00:00"),
      et("2026-04-21T14:00:00"),
      et("2026-04-21T17:00:00"), // 3-hour stub
    ]);
    // Stub bucket has only 12 underlying 15m bars (3h * 4 = 12), each
    // with volume 1, so volume sum = 12. Full buckets have 16.
    expect(out[0].volume).toBe(16);
    expect(out[5].volume).toBe(12);
  });
});

describe("aggregateCandles — boundary close-stamps land in the correct bucket", () => {
  it("Tue 22:00, 02:00, 06:00, 10:00, 14:00 each land in bucket 0..4 (not 1..5)", () => {
    // Each test bar carries a unique volume so we can identify which
    // bucket it ended up in.
    const input: Candle[] = [
      { timestamp: et("2026-04-20T22:00:00"), open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { timestamp: et("2026-04-21T02:00:00"), open: 2, high: 2, low: 2, close: 2, volume: 200 },
      { timestamp: et("2026-04-21T06:00:00"), open: 3, high: 3, low: 3, close: 3, volume: 300 },
      { timestamp: et("2026-04-21T10:00:00"), open: 4, high: 4, low: 4, close: 4, volume: 400 },
      { timestamp: et("2026-04-21T14:00:00"), open: 5, high: 5, low: 5, close: 5, volume: 500 },
    ];
    const out = aggregateCandles(input, "4h", ETH_OPTS);
    expect(out).toHaveLength(5);
    // Each input bar should be alone in its own bucket, close-stamped at
    // exactly the input timestamp. If the `-1` adjustment is removed,
    // each bar gets pushed into the NEXT bucket and the close-stamps
    // shift by one period (22:00 becomes 02:00, etc.).
    expect(out[0].timestamp).toBe(et("2026-04-20T22:00:00"));
    expect(out[0].volume).toBe(100);
    expect(out[1].timestamp).toBe(et("2026-04-21T02:00:00"));
    expect(out[1].volume).toBe(200);
    expect(out[2].timestamp).toBe(et("2026-04-21T06:00:00"));
    expect(out[2].volume).toBe(300);
    expect(out[3].timestamp).toBe(et("2026-04-21T10:00:00"));
    expect(out[3].volume).toBe(400);
    expect(out[4].timestamp).toBe(et("2026-04-21T14:00:00"));
    expect(out[4].volume).toBe(500);
  });
});

describe("aggregateCandles — bars in maintenance break are dropped", () => {
  it("a 17:30 ET close-stamp does not land in any bucket and does not contaminate the SD's aggregation", () => {
    // 17:00 = last in-session bar of Tue session-day; 17:30 = in the
    // maintenance break (no real bar should ever close-stamp there);
    // 18:15 = first in-session bar of Wed session-day.
    const input: Candle[] = [
      bar("2026-04-21T17:00:00", [10, 10, 10, 10]),
      bar("2026-04-21T17:30:00", [99, 99, 99, 99]), // poisoned bar in break
      bar("2026-04-21T18:15:00", [20, 20, 20, 20]),
    ];
    const out = aggregateCandles(input, "4h", ETH_OPTS);
    // The 17:30 bar is dropped. Tue session-day gets one bar (the 17:00
    // stub), Wed session-day gets one bar (the 18:15 first bucket).
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBe(et("2026-04-21T17:00:00"));
    expect(out[0].volume).toBe(10); // not 109 (= 10 + 99) — the poison was dropped
    expect(out[1].timestamp).toBe(et("2026-04-21T18:15:00"));
    expect(out[1].volume).toBe(20);
  });
});

describe("aggregateCandles — output sorted ascending", () => {
  it("sorts even when input arrives out of order", () => {
    // Pairs that legitimately fall in the same 30m bucket under
    // close-stamped semantics: (10:15, 10:30) → bucket close-stamp 10:30.
    // Bar 10:15 covers data 10:00-10:14:59; bar 10:30 covers 10:15-10:29:59.
    const input: Candle[] = [
      bar("2026-05-05T10:30:00", [205, 215, 200, 210]),
      bar("2026-05-05T10:15:00", [200, 210, 195, 205]),
      bar("2026-05-04T10:30:00", [105, 120, 100, 115]),
      bar("2026-05-04T10:15:00", [100, 110, 95, 105]),
    ];
    const out = aggregateCandles(input, "30m", ETH_OPTS);
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBeLessThan(out[1].timestamp);
  });
});

describe("aggregateCandles — DST", () => {
  // CME ETH sessions never themselves span the DST transition (DST falls
  // in the offline weekend gap). The meaningful DST test is: do EST-week
  // and EDT-week sessions both produce the standard 5-full + 1-stub
  // pattern? They should, because the math is wall-clock anchored.

  it("EST week — Fri 2026-01-09 produces 5 full + 1 stub of 3h", () => {
    const start = et("2026-01-08T18:00:00"); // Thu 18:00 EST
    const end = et("2026-01-09T17:00:00");   // Fri 17:00 EST
    const input: Candle[] = [];
    for (let ts = start + 900; ts <= end; ts += 900) {
      input.push({ timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    const out = aggregateCandles(input, "4h", ETH_OPTS);
    expect(out).toHaveLength(6);
    expect(out[0].timestamp).toBe(et("2026-01-08T22:00:00"));
    expect(out[5].timestamp).toBe(et("2026-01-09T17:00:00"));
    expect(out[0].volume).toBe(16); // full bucket
    expect(out[5].volume).toBe(12); // 3h stub
  });

  it("EDT week — Fri 2026-07-10 produces 5 full + 1 stub of 3h", () => {
    const start = et("2026-07-09T18:00:00"); // Thu 18:00 EDT
    const end = et("2026-07-10T17:00:00");   // Fri 17:00 EDT
    const input: Candle[] = [];
    for (let ts = start + 900; ts <= end; ts += 900) {
      input.push({ timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    const out = aggregateCandles(input, "4h", ETH_OPTS);
    expect(out).toHaveLength(6);
    expect(out[0].timestamp).toBe(et("2026-07-09T22:00:00"));
    expect(out[5].timestamp).toBe(et("2026-07-10T17:00:00"));
  });
});

describe("aggregateCandles — 24/7 continuous (UTC)", () => {
  it("4h aggregation produces 6 buckets per UTC day with no stubs", () => {
    // Build all 96 15m close-stamps for one UTC day (Tue 2026-04-21).
    // First close-stamp is Tue 00:15 UTC; last is Wed 00:00 UTC (= Tue 24:00).
    const start = utc("2026-04-21T00:00:00");
    const end = utc("2026-04-22T00:00:00"); // inclusive close-stamp boundary
    const input: Candle[] = [];
    for (let ts = start + 900; ts <= end; ts += 900) {
      input.push({ timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    const out = aggregateCandles(input, "4h", UTC_OPTS);
    expect(out).toHaveLength(6);
    expect(out[0].timestamp).toBe(utc("2026-04-21T04:00:00"));
    expect(out[1].timestamp).toBe(utc("2026-04-21T08:00:00"));
    expect(out[2].timestamp).toBe(utc("2026-04-21T12:00:00"));
    expect(out[3].timestamp).toBe(utc("2026-04-21T16:00:00"));
    expect(out[4].timestamp).toBe(utc("2026-04-21T20:00:00"));
    expect(out[5].timestamp).toBe(utc("2026-04-22T00:00:00"));
    // Each bucket should be full (16 underlying 15m bars × volume 1).
    expect(out.every((c) => c.volume === 16)).toBe(true);
    // Suppress unused warning on utcBar
    void utcBar;
  });
});

describe("aggregateCandles — partial flag on most-recent bar", () => {
  it("most-recent aggregated bar of an in-progress session is marked partial=true", () => {
    // Build bars from session open through 12:00 ET on Tue 2026-04-21.
    // Set `now` to Tue 14:00 ET (still mid-session, before 17:00 close).
    const start = et("2026-04-20T18:00:00");
    const cutoff = et("2026-04-21T12:00:00");
    const input: Candle[] = [];
    for (let ts = start + 900; ts <= cutoff; ts += 900) {
      input.push({ timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    const opts: AggregateOptions = {
      ...ETH_OPTS,
      now: et("2026-04-21T14:00:00"), // mid-session
    };
    const out = aggregateCandles(input, "4h", opts);
    // Last bucket should be marked partial; all earlier buckets should
    // not have the field set.
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i].partial).toBeUndefined();
    }
    expect(out[out.length - 1].partial).toBe(true);
  });

  it("after session close (now > endUnix), no bar is marked partial — even the stub", () => {
    const start = et("2026-04-20T18:00:00");
    const end = et("2026-04-21T17:00:00");
    const input: Candle[] = [];
    for (let ts = start + 900; ts <= end; ts += 900) {
      input.push({ timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    const opts: AggregateOptions = {
      ...ETH_OPTS,
      now: et("2026-04-22T10:00:00"), // next day, well past Tue's close
    };
    const out = aggregateCandles(input, "4h", opts);
    expect(out.every((c) => c.partial === undefined)).toBe(true);
  });
});

describe("calendar-aware aggregation (holiday early close)", () => {
  const FEB16_CAL = new Map([
    [
      "2026-02-16",
      {
        date: "2026-02-16",
        kind: "modified" as const,
        closeTime: "13:00",
        source: "bootstrap" as const,
        description: "Presidents Day",
      },
    ],
  ]);

  it("does not mark the 13:00 final bar partial once the adjusted close has passed", () => {
    const input: Candle[] = [
      bar("2026-02-16T12:45", [100, 101, 99, 100]),
      bar("2026-02-16T13:00", [100, 102, 100, 101]),
    ];
    const out = aggregateCandles(input, "15m", {
      ...ETH_OPTS,
      calendar: FEB16_CAL,
      now: et("2026-02-16T14:00"), // after the 13:00 early close, before 17:00
    });
    // Without the calendar the template's 17:00 close makes this bar look
    // mid-session and wrongly partial.
    expect(out[out.length - 1].partial).toBeUndefined();
  });

  it("derived stamps on an early-close day satisfy the validator's adjusted geometry", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { initializeSchema } = await import("../src/db/schema.js");
    const { validateSessionDay } = await import("../src/core/cache/validator.js");

    const start = et("2026-02-15T18:00");
    const end = et("2026-02-16T13:00"); // 68,400s session = 76 x 15m
    const input: Candle[] = [];
    for (let ts = start + 900; ts <= end; ts += 900) {
      input.push({ timestamp: ts, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    }
    expect(input).toHaveLength(76);

    const db = new Database(":memory:");
    initializeSchema(db);
    const insert = db.prepare(
      "INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume) VALUES ('NQ', ?, ?, 1, 1, 1, 1, 1)",
    );
    const adjustedDay = { label: "2026-02-16", startUnix: start, endUnix: end };

    for (const tf of ["30m", "1h", "2h", "4h"] as const) {
      const derived = aggregateCandles(input, tf, {
        ...ETH_OPTS,
        calendar: FEB16_CAL,
        now: et("2026-03-01T00:00"),
      });
      for (const c of derived) insert.run(tf, c.timestamp);
      const v = validateSessionDay(db, "NQ", adjustedDay, tf, et("2026-03-01T00:00"));
      expect(v.status, `${tf}: missing=${v.missing.join(",")} extra=${v.extra.join(",")}`).toBe("ok");
    }
  });
});

describe("15s raw passthrough", () => {
  it("short-circuits like the other raw streams (no bucketing, partial-marking only)", () => {
    const input: Candle[] = [
      { timestamp: et("2026-04-21T10:00:15"), open: 1, high: 2, low: 1, close: 2, volume: 5 },
      { timestamp: et("2026-04-21T10:00:30"), open: 2, high: 3, low: 2, close: 3, volume: 7 },
    ];
    const out = aggregateCandles(input, "15s", {
      ...ETH_OPTS,
      now: et("2026-04-22T10:00:00"), // session closed — no partial flag
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ timestamp: input[0].timestamp, volume: 5 });
    expect(out.every((c) => c.partial === undefined)).toBe(true);
  });
});
