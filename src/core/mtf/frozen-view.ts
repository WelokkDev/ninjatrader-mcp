import type { Candle, Timeframe } from "../types.js";
import type { SessionTemplate } from "../sessions/types.js";
import type { FrozenView } from "./types.js";
import { sessionDayContaining } from "../sessions/session-day.js";

// Intraday period lengths in seconds. "1d" is intentionally absent, daily bars come from the private session-aligned daily aggregator, 
// not here (mirrors core/aggregator.ts, which likewise refuses "1d").
export const PERIOD_SECONDS: Record<Exclude<Timeframe, "1d">, number> = {
  "15s": 15,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "2h": 120 * 60,
  "4h": 240 * 60,
};

// Bucket index for a close-stamped bar within its session-day. The `- 1` is load-bearing (see bucketAsOf): 
// it pulls a boundary close-stamp into the bucket whose data window it ends, not the next one. 
// Exported so the build-once frozen-source precompute uses the EXACT same math (no drift).
export function bucketIndexOf(
  timestamp: number,
  sessionDayStartUnix: number,
  periodSeconds: number,
): number {
  return Math.floor((timestamp - sessionDayStartUnix - 1) / periodSeconds);
}

// Build the as-of multi-timeframe snapshot for a single decision instant.
// `primaryBars` is the entry-TF series; `timeframes` are the higher TFs to derive; `session` drives bucket-boundary alignment. 
// Everything stamped after `asOf` (unix seconds) is excluded, and each HTF is split into the
// closed-bucket `completed` cut and the forming-bar-inclusive `asOfView` cut (see FrozenView).
export function buildFrozenView(args: {
  primaryBars: Candle[];
  asOf: number;
  timeframes: Timeframe[];
  session: SessionTemplate;
}): FrozenView {
  const { primaryBars, asOf, timeframes, session } = args;

  // primary = entry-TF bars visible at asOf, ascending. Filter a copy and sort it — never mutate the caller's array. 
  // Valid input is already ascending so the sort is a no-op there, but it guarantees the ordering invariant the SMA / zone consumers depend on.
  const primary = primaryBars
    .filter((b) => b.timestamp <= asOf)
    .sort((a, b) => a.timestamp - b.timestamp);

  const completed = new Map<Timeframe, Candle[]>();
  const asOfView = new Map<Timeframe, Candle[]>();

  for (const tf of timeframes) {
    if (tf === "1d") {
      throw new Error(
        `buildFrozenView: "1d" is out of scope — daily bars come from the private session-aligned aggregator, not the intraday frozen view. Pass a subset of 15m/30m/1h/2h/4h.`,
      );
    }
    const { completedBars, formingBar } = bucketAsOf(
      primary,
      asOf,
      PERIOD_SECONDS[tf],
      session,
    );
    completed.set(tf, completedBars);
    asOfView.set(
      tf,
      formingBar ? [...completedBars, formingBar] : [...completedBars],
    );
  }

  return { primary, completed, asOfView };
}

interface AsOfBuckets {
  completedBars: Candle[];
  formingBar: Candle | null;
}

// Bucket `primary` (already filtered to <= asOf) into `periodSeconds` buckets with the EXACT math of core/aggregator.ts, 
// sessionDayContaining + floor((t - startUnix - 1) / periodSeconds), close-stamped at the last underlying bar, then split by bucket period-end vs asOf:
//  - period-end <= asOf → completed (safe for WAW / zone detection)
//  - period-end >  asOf → the single forming bar (live, for SMA / trend)
// A bucket's period-end is its natural grid close clamped to the session-day end, so a session's trailing stub 
// (e.g. CME ETH's 3-hour 14:00–17:00 4h bucket) counts as complete the instant asOf reaches the 17:00 session close, not at the unreachable 18:00 grid line.
function bucketAsOf(
  primary: readonly Candle[],
  asOf: number,
  periodSeconds: number,
  session: SessionTemplate,
): AsOfBuckets {
  const buckets = new Map<
    string,
    { bars: Candle[]; sdStart: number; sdEnd: number; index: number }
  >();

  for (const c of primary) {
    const sd = sessionDayContaining(c.timestamp, session);
    // Bars outside any session-day (maintenance break / weekend gap) are dropped from HTF aggregation, exactly as core/aggregator.ts does.
    // They stay in `primary` (the raw entry-TF series) but never form an HTF bar.
    if (sd === null) continue;
    // The `- 1` is load-bearing: it pulls a boundary close-stamp (e.g. a 4h bucket's 22:00 close) into the bucket whose data window it ends, not the next one.
    const index = bucketIndexOf(c.timestamp, sd.startUnix, periodSeconds);
    const key = `${sd.label}|${index}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { bars: [], sdStart: sd.startUnix, sdEnd: sd.endUnix, index };
      buckets.set(key, bucket);
    }
    bucket.bars.push(c);
  }

  const completedBars: Candle[] = [];
  let formingBar: Candle | null = null;
  let formingStamp = -Infinity;

  for (const bucket of buckets.values()) {
    bucket.bars.sort((a, b) => a.timestamp - b.timestamp);
    const candle = aggregateBucket(bucket.bars);
    // Natural grid close, clamped to the session-day end. This never markPartial / now — decides completed vs forming.
    const periodEnd = Math.min(
      bucket.sdStart + (bucket.index + 1) * periodSeconds,
      bucket.sdEnd,
    );
    if (periodEnd <= asOf) {
      completedBars.push(candle);
    } else if (candle.timestamp > formingStamp) {
      // At most one bucket can straddle asOf: `primary` is pre-filtered to <= asOf, so any bucket after this one would be empty. 
      // The max-timestamp guard is belt-and-suspenders if that ever breaks.
      formingBar = candle;
      formingStamp = candle.timestamp;
    }
  }

  completedBars.sort((a, b) => a.timestamp - b.timestamp);
  return { completedBars, formingBar };
}

// Aggregate one bucket's underlying bars into a single close-stamped candle. 
// Byte-identical to core/aggregator.ts: open = first bar, close and timestamp = last bar, high / low / volume reduced across the bucket.
// Never carries a `partial` flag — completed-vs-live is encoded by which FrozenView map the bar lands in, not by the field 
// (computeSMAOnCandles forces a trailing-partial SMA to null and throws on a non-trailing one, so a flagged forming bar would break SMA reads).
export function aggregateBucket(group: readonly Candle[]): Candle {
  const last = group[group.length - 1];
  return {
    timestamp: last.timestamp,
    open: group[0].open,
    high: Math.max(...group.map((c) => c.high)),
    low: Math.min(...group.map((c) => c.low)),
    close: last.close,
    volume: group.reduce((sum, c) => sum + c.volume, 0),
  };
}
