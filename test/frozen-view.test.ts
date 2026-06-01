import { describe, it, expect } from "vitest";
import { buildFrozenView } from "../src/core/mtf/frozen-view.js";
import { aggregateCandles, type AggregateOptions } from "../src/core/aggregator.js";
import {
  CME_US_INDEX_FUTURES_ETH,
  CONTINUOUS_24_7,
} from "../src/core/sessions/templates.js";
import type { Candle, Timeframe } from "../src/core/types.js";

// DST-safe instant helpers (same pattern as aggregator.test.ts)

// Unix seconds for a wall-clock instant in America/New_York, DST-correct for both EST and EDT.
function et(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (!m) throw new Error(`bad ET instant: ${iso}`);
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

function utc(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (!m) throw new Error(`bad UTC instant: ${iso}`);
  const [, y, mo, d, hh, mm, ss] = m;
  return Math.floor(Date.UTC(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0) / 1000);
}

// Previous calendar day, "YYYY-MM-DD" → "YYYY-MM-DD". Pure UTC arithmetic.
function prevDay(iso: string): string {
  const [y, mo, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d - 1));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

const ETH = CME_US_INDEX_FUTURES_ETH;
const FAR = utc("2099-01-01T00:00:00"); // every bar is "long closed" relative to this

function ethOpts(now: number): AggregateOptions {
  return {
    session: ETH,
    alignment: "session_aligned_with_stubs",
    timestampConvention: "close-stamped",
    now,
  };
}

function mk(ts: number, o: number, h: number, l: number, c: number, v: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: v };
}

// Full 5m series for one CME ETH session-day (opens prevDay 18:00 ET, closes 17:00 ET), flat OHLC at 100, ascending. 276 bars (23h × 12).
function eth5mFlat(closeDate: string): Candle[] {
  const open = et(`${prevDay(closeDate)}T18:00:00`);
  const close = et(`${closeDate}T17:00:00`);
  const out: Candle[] = [];
  for (let ts = open + 300; ts <= close; ts += 300) {
    out.push(mk(ts, 100, 100, 100, 100, 1));
  }
  return out;
}

function expectNoPartial(bars: readonly Candle[]): void {
  for (const b of bars) expect(b.partial).toBeUndefined();
}

// Boundary: asOf exactly on a 4h close

describe("buildFrozenView — asOf exactly on a 4h close", () => {
  it("the boundary bar is in completed, not duplicated into a forming slot", () => {
    const bars = eth5mFlat("2026-04-21");
    const asOf = et("2026-04-21T10:00:00"); // close of the (06:00,10:00] 4h bucket
    const fv = buildFrozenView({ primaryBars: bars, asOf, timeframes: ["4h"], session: ETH });

    const completed = fv.completed.get("4h")!;
    // Four closed 4h buckets: 22:00, 02:00, 06:00, 10:00.
    expect(completed.map((b) => b.timestamp)).toEqual([
      et("2026-04-20T22:00:00"),
      et("2026-04-21T02:00:00"),
      et("2026-04-21T06:00:00"),
      et("2026-04-21T10:00:00"),
    ]);
    // No bar past asOf leaked into completed.
    expect(completed.every((b) => b.timestamp <= asOf)).toBe(true);
    // Empty forming bucket → asOfView is identical to completed (the 10:00 bar appears once, in completed, never duplicated as a forming bar).
    expect(fv.asOfView.get("4h")).toEqual(completed);
  });
});

// asOf at close −1s / +1s flips forming↔completed

describe("buildFrozenView — forming/completed flips at a 4h boundary ±1s", () => {
  const bars = eth5mFlat("2026-04-21");
  const close = et("2026-04-21T10:00:00");

  it("close − 1s: the (06:00,10:00] bucket is still forming", () => {
    const fv = buildFrozenView({ primaryBars: bars, asOf: close - 1, timeframes: ["4h"], session: ETH });
    const completed = fv.completed.get("4h")!;
    const asOfView = fv.asOfView.get("4h")!;
    // 22:00 / 02:00 / 06:00 closed; the 10:00 bucket has not closed yet.
    expect(completed.map((b) => b.timestamp)).toEqual([
      et("2026-04-20T22:00:00"),
      et("2026-04-21T02:00:00"),
      et("2026-04-21T06:00:00"),
    ]);
    // asOfView carries the forming bar as its trailing element, close-
    // stamped at the last visible 5m bar (09:55), not 10:00.
    expect(asOfView).toHaveLength(4);
    expect(asOfView[asOfView.length - 1].timestamp).toBe(et("2026-04-21T09:55:00"));
    // The forming bar is NOT in completed.
    expect(completed.some((b) => b.timestamp === et("2026-04-21T09:55:00"))).toBe(false);
  });

  it("close exactly: the bucket is completed, no forming slot", () => {
    const fv = buildFrozenView({ primaryBars: bars, asOf: close, timeframes: ["4h"], session: ETH });
    expect(fv.completed.get("4h")!.map((b) => b.timestamp)).toContain(close);
    expect(fv.asOfView.get("4h")).toEqual(fv.completed.get("4h"));
  });

  it("close + 1s: still completed, the next 5m bar (10:05) is not yet visible", () => {
    const fv = buildFrozenView({ primaryBars: bars, asOf: close + 1, timeframes: ["4h"], session: ETH });
    const completed = fv.completed.get("4h")!;
    expect(completed[completed.length - 1].timestamp).toBe(close);
    // No forming bar — the only bar that could start one (10:05) is > asOf.
    expect(fv.asOfView.get("4h")).toEqual(completed);
  });
});

// Leak probe

describe("buildFrozenView — leak probe (no future data reaches the frozen view)", () => {
  it("a forming bar reflects only bars ≤ asOf; future spikes never appear", () => {
    // Session open → 10:00; asOf mid-way through the (06:00,10:00] 4h bucket. Bars inside that bucket but ≤ asOf carry a 99–101 range;
    // bars > asOf carry an absurd 1…9999 spike that MUST NOT leak.
    const open = et("2026-04-20T18:00:00");
    const end = et("2026-04-21T10:00:00");
    const b3Start = et("2026-04-21T06:00:00");
    const asOf = et("2026-04-21T08:00:00");
    const bars: Candle[] = [];
    for (let ts = open + 300; ts <= end; ts += 300) {
      const inB3 = ts > b3Start && ts <= end;
      if (inB3 && ts <= asOf) bars.push(mk(ts, 100, 101, 99, 100, 1));
      else if (inB3 && ts > asOf) bars.push(mk(ts, 100, 9999, 1, 100, 1)); // future spike
      else bars.push(mk(ts, 100, 100, 100, 100, 1));
    }

    const fv = buildFrozenView({ primaryBars: bars, asOf, timeframes: ["4h"], session: ETH });
    const completed = fv.completed.get("4h")!;
    const asOfView = fv.asOfView.get("4h")!;

    // The not-yet-closed (06:00,10:00] bucket never appears in completed.
    expect(completed).toHaveLength(3); // 22:00, 02:00, 06:00
    expect(completed.every((b) => b.timestamp <= asOf)).toBe(true);

    // Its data appears ONLY as asOfView's trailing forming bar, built from exactly the 24 in-window bars (06:05..08:00), the spike is gone.
    const forming = asOfView[asOfView.length - 1];
    expect(forming.timestamp).toBe(asOf); // close-stamped at the last visible bar
    expect(forming.high).toBe(101);
    expect(forming.low).toBe(99);
    expect(forming.volume).toBe(24);

    // The future spike must not have leaked into ANY frozen bar.
    for (const b of [...completed, ...asOfView]) {
      expect(b.high).toBeLessThanOrEqual(101);
      expect(b.low).toBeGreaterThanOrEqual(99);
    }
  });
});

// Empty forming bucket (asOf on a boundary) → asOfView == completed

describe("buildFrozenView — empty forming bucket", () => {
  it("asOf on an HTF boundary yields asOfView identical to completed across all TFs", () => {
    const bars = eth5mFlat("2026-04-21");
    // 02:00 ET is simultaneously a 4h / 2h / 1h / 30m / 15m boundary.
    const asOf = et("2026-04-21T02:00:00");
    const tfs: Timeframe[] = ["15m", "30m", "1h", "2h", "4h"];
    const fv = buildFrozenView({ primaryBars: bars, asOf, timeframes: tfs, session: ETH });
    for (const tf of tfs) {
      expect(fv.asOfView.get(tf)).toEqual(fv.completed.get(tf));
      expect(fv.completed.get(tf)!.every((b) => b.timestamp <= asOf)).toBe(true);
    }
  });
});

// 5m → 15m aggregation (the path aggregateCandles can't do)

describe("buildFrozenView — 5m→15m aggregation", () => {
  it("genuinely aggregates 5m into 15m, unlike aggregateCandles' 15m passthrough", () => {
    // Six 5m bars inside the Tue 2026-04-21 session (open Mon 18:00 ET): two complete 15m buckets.
    const t = (hhmm: string) => et(`2026-04-20T${hhmm}:00`);
    const bars: Candle[] = [
      mk(t("18:05"), 100, 105, 98, 101, 1),
      mk(t("18:10"), 101, 110, 100, 108, 2),
      mk(t("18:15"), 108, 112, 104, 106, 3),
      mk(t("18:20"), 106, 107, 95, 99, 4),
      mk(t("18:25"), 99, 103, 97, 102, 5),
      mk(t("18:30"), 102, 109, 101, 107, 6),
    ];

    const fv = buildFrozenView({ primaryBars: bars, asOf: FAR, timeframes: ["15m"], session: ETH });
    const out = fv.completed.get("15m")!;
    expect(out).toEqual([
      mk(t("18:15"), 100, 112, 98, 106, 6),
      mk(t("18:30"), 106, 109, 95, 107, 15),
    ]);

    // Documents the trap: aggregateCandles treats "15m" as a passthrough, returning the six raw 5m bars un-aggregated. buildFrozenView must not.
    expect(aggregateCandles(bars, "15m", ethOpts(FAR))).toHaveLength(6);
  });
});

// Consistency with aggregateCandles past series end

describe("buildFrozenView — consistency with aggregateCandles (everything closed)", () => {
  it("completed[tf] equals aggregateCandles(primaryBars, tf) for 30m/1h/2h/4h", () => {
    // Two full session-days of varied OHLC so the equality is non-trivial.
    const bars: Candle[] = [];
    let i = 0;
    for (const cd of ["2026-04-21", "2026-04-22"]) {
      const open = et(`${prevDay(cd)}T18:00:00`);
      const close = et(`${cd}T17:00:00`);
      for (let ts = open + 300; ts <= close; ts += 300) {
        const base = 100 + ((i * 13) % 37);
        bars.push(mk(ts, base, base + 4, base - 3, base + 2, 1 + (i % 6)));
        i++;
      }
    }

    const tfs: Timeframe[] = ["30m", "1h", "2h", "4h"];
    const fv = buildFrozenView({ primaryBars: bars, asOf: FAR, timeframes: tfs, session: ETH });
    for (const tf of tfs) {
      expect(fv.completed.get(tf)).toEqual(aggregateCandles(bars, tf, ethOpts(FAR)));
      // Past series end there is nothing forming.
      expect(fv.asOfView.get(tf)).toEqual(fv.completed.get(tf));
    }
  });
});

// DST session-days

describe("buildFrozenView — DST-correct session boundaries", () => {
  it("EST-week session (Jan) produces the standard 4h close-stamps", () => {
    const bars = eth5mFlat("2026-01-06"); // Tue, EST (UTC−5)
    const fv = buildFrozenView({ primaryBars: bars, asOf: FAR, timeframes: ["4h"], session: ETH });
    expect(fv.completed.get("4h")!.map((b) => b.timestamp)).toEqual([
      et("2026-01-05T22:00:00"),
      et("2026-01-06T02:00:00"),
      et("2026-01-06T06:00:00"),
      et("2026-01-06T10:00:00"),
      et("2026-01-06T14:00:00"),
      et("2026-01-06T17:00:00"), // 3h stub
    ]);
  });

  it("the forming↔completed flip lands on the correct wall-clock instant in EST", () => {
    const bars = eth5mFlat("2026-01-06");
    const close = et("2026-01-06T10:00:00");
    // If session math mishandled the EST offset, this UTC instant would not align with the bucket close and the lengths would differ.
    const before = buildFrozenView({ primaryBars: bars, asOf: close - 1, timeframes: ["4h"], session: ETH });
    const at = buildFrozenView({ primaryBars: bars, asOf: close, timeframes: ["4h"], session: ETH });
    expect(before.completed.get("4h")).toHaveLength(3);
    expect(at.completed.get("4h")).toHaveLength(4);
    expect(at.completed.get("4h")![3].timestamp).toBe(close);
  });
});

// Invariants

describe("buildFrozenView — invariants", () => {
  it("never emits a partial-flagged bar, in either cut", () => {
    const bars = eth5mFlat("2026-04-21");
    const asOf = et("2026-04-21T12:30:00"); // mid-bucket → there IS a forming bar
    const tfs: Timeframe[] = ["15m", "30m", "1h", "2h", "4h"];
    const fv = buildFrozenView({ primaryBars: bars, asOf, timeframes: tfs, session: ETH });
    expectNoPartial(fv.primary);
    for (const tf of tfs) {
      expectNoPartial(fv.completed.get(tf)!);
      expectNoPartial(fv.asOfView.get(tf)!);
      // asOfView = completed + (at most) one forming bar.
      const extra = fv.asOfView.get(tf)!.length - fv.completed.get(tf)!.length;
      expect(extra === 0 || extra === 1).toBe(true);
    }
  });

  it("primary is exactly the entry-TF bars with timestamp ≤ asOf", () => {
    const bars = eth5mFlat("2026-04-21");
    const asOf = et("2026-04-21T10:00:00");
    const fv = buildFrozenView({ primaryBars: bars, asOf, timeframes: [], session: ETH });
    expect(fv.primary.every((b) => b.timestamp <= asOf)).toBe(true);
    expect(fv.primary.some((b) => b.timestamp === asOf)).toBe(true); // boundary bar included
    expect(fv.primary.some((b) => b.timestamp === asOf + 300)).toBe(false); // next bar excluded
  });

  it("does not mutate the caller's array and sorts primary ascending", () => {
    const input = [...eth5mFlat("2026-04-21")].reverse(); // descending on purpose
    const snapshot = input.map((b) => b.timestamp);
    const fv = buildFrozenView({ primaryBars: input, asOf: FAR, timeframes: ["4h"], session: ETH });
    // Input left untouched (still descending, same order).
    expect(input.map((b) => b.timestamp)).toEqual(snapshot);
    // primary is returned ascending regardless of input order.
    for (let i = 1; i < fv.primary.length; i++) {
      expect(fv.primary[i].timestamp).toBeGreaterThan(fv.primary[i - 1].timestamp);
    }
  });

  it("throws on '1d' (daily comes from the private session-aligned aggregator)", () => {
    expect(() =>
      buildFrozenView({ primaryBars: eth5mFlat("2026-04-21"), asOf: FAR, timeframes: ["1d"], session: ETH }),
    ).toThrow(/1d/);
  });

  it("handles a 24/7 (UTC) session with no trailing stub", () => {
    const open = utc("2026-04-21T00:00:00");
    const close = open + 24 * 3600; // 24:00 = next 00:00
    const bars: Candle[] = [];
    for (let ts = open + 300; ts <= close; ts += 300) bars.push(mk(ts, 100, 100, 100, 100, 1));

    const asOf = utc("2026-04-21T12:00:00");
    const fv = buildFrozenView({ primaryBars: bars, asOf, timeframes: ["4h"], session: CONTINUOUS_24_7 });
    expect(fv.completed.get("4h")!.map((b) => b.timestamp)).toEqual([
      utc("2026-04-21T04:00:00"),
      utc("2026-04-21T08:00:00"),
      utc("2026-04-21T12:00:00"),
    ]);
    expect(fv.asOfView.get("4h")).toEqual(fv.completed.get("4h")); // boundary → no forming
  });
});
