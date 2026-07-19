import type { Candle, Timeframe } from "../types.js";
import type { SessionTemplate } from "../sessions/types.js";
import type { FrozenView } from "./types.js";
import { makeSessionDayResolver } from "../sessions/session-day.js";
import { PERIOD_SECONDS, aggregateBucket, bucketIndexOf } from "./frozen-view.js";

interface SourceBucket {
  periodEnd: number; // natural grid close clamped to the session-day end
  candle: Candle; // aggregate of ALL the bucket's bars (valid once completed)
  bars: Candle[]; // the bucket's sub-bars, ascending (for forming re-aggregation)
  firstTs: number;
}

export interface FrozenSource {
  viewAt(asOf: number): FrozenView;
}

// Precompute the per-TF bucket lists over the full primary series. Reuse the
// returned source's `viewAt` for every decision instant.
export function buildFrozenSource(args: {
  primaryBars: Candle[];
  timeframes: Timeframe[];
  session: SessionTemplate;
}): FrozenSource {
  const { timeframes, session } = args;
  const primary = [...args.primaryBars].sort((a, b) => a.timestamp - b.timestamp);

  const bucketsByTf = new Map<Timeframe, SourceBucket[]>();
  const periodEndsByTf = new Map<Timeframe, number[]>();
  for (const tf of timeframes) {
    if (tf === "1d") {
      throw new Error(
        `buildFrozenSource: "1d" is out of scope — pass a subset of 15m/30m/1h/2h/4h.`,
      );
    }
    const buckets = bucketize(primary, PERIOD_SECONDS[tf], session);
    bucketsByTf.set(tf, buckets);
    periodEndsByTf.set(
      tf,
      buckets.map((b) => b.periodEnd),
    );
  }

  return {
    viewAt(asOf: number): FrozenView {
      const primarySlice = primary.slice(0, upperBoundTs(primary, asOf));

      const completed = new Map<Timeframe, Candle[]>();
      const asOfView = new Map<Timeframe, Candle[]>();

      for (const tf of timeframes) {
        const buckets = bucketsByTf.get(tf)!;
        const periodEnds = periodEndsByTf.get(tf)!;
        const c = upperBoundNum(periodEnds, asOf); // # buckets with periodEnd <= asOf

        const completedBars: Candle[] = new Array(c);
        for (let i = 0; i < c; i++) completedBars[i] = buckets[i].candle;

        // The single straddling bucket (periodEnd > asOf) is the forming bar, re-aggregated from ONLY its sub-bars <= asOf. 
        // Completed buckets are entirely <= periodEnd <= asOf, so their precomputed aggregate is safe.
        let formingBar: Candle | null = null;
        const straddle = buckets[c];
        if (straddle && straddle.firstTs <= asOf) {
          const sub = straddle.bars.filter((b) => b.timestamp <= asOf);
          if (sub.length > 0) formingBar = aggregateBucket(sub);
        }

        completed.set(tf, completedBars);
        asOfView.set(
          tf,
          formingBar ? [...completedBars, formingBar] : [...completedBars],
        );
      }

      return { primary: primarySlice, completed, asOfView };
    },
  };
}

// Bucketize the full primary into ordered buckets. Bars outside any session-day
// (maintenance break / weekend gap) are dropped from aggregation, exactly as the frozen view does.
function bucketize(
  primary: readonly Candle[],
  periodSeconds: number,
  session: SessionTemplate,
): SourceBucket[] {
  const map = new Map<
    string,
    { bars: Candle[]; sdStart: number; sdEnd: number; index: number }
  >();
  const resolveDay = makeSessionDayResolver(session);
  for (const c of primary) {
    const sd = resolveDay(c.timestamp);
    if (sd === null) continue;
    const index = bucketIndexOf(c.timestamp, sd.startUnix, periodSeconds);
    const key = `${sd.label}|${index}`;
    let b = map.get(key);
    if (!b) {
      b = { bars: [], sdStart: sd.startUnix, sdEnd: sd.endUnix, index };
      map.set(key, b);
    }
    b.bars.push(c);
  }
  const out: SourceBucket[] = [];
  for (const b of map.values()) {
    b.bars.sort((a, bb) => a.timestamp - bb.timestamp);
    const periodEnd = Math.min(b.sdStart + (b.index + 1) * periodSeconds, b.sdEnd);
    out.push({
      periodEnd,
      candle: aggregateBucket(b.bars),
      bars: b.bars,
      firstTs: b.bars[0].timestamp,
    });
  }
  out.sort((a, b) => a.periodEnd - b.periodEnd);
  return out;
}

// Count of bars with timestamp <= asOf (ascending series).
function upperBoundTs(bars: readonly Candle[], asOf: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].timestamp <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Count of values <= asOf (ascending array).
function upperBoundNum(arr: readonly number[], asOf: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
