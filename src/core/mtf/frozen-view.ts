import type { Candle, Timeframe } from "../types.js";
import type { SessionTemplate } from "../sessions/types.js";
import type { SessionCalendar } from "../sessions/calendar.js";
import type { FrozenView } from "./types.js";
import { aggregateBucket } from "../aggregator.js";
import { bucketIndexOf, bucketPeriodEnd } from "../buckets.js";
import { makeSessionDayResolver } from "../sessions/session-day.js";

// Intraday period lengths in seconds. "1d" is intentionally absent: daily is a
// RAW stream fetched from NT8 (one bar per session-day), never bucketed from
// intraday bars (mirrors core/aggregator.ts, which likewise refuses "1d").
export const PERIOD_SECONDS: Record<Exclude<Timeframe, "1d">, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "2h": 120 * 60,
  "4h": 240 * 60,
};

// Build the as-of multi-timeframe snapshot for a single decision instant.
// `primaryBars` is the entry-TF series; `timeframes` are the higher TFs to derive; `session` drives bucket-boundary alignment. 
// Everything stamped after `asOf` (unix seconds) is excluded, and each HTF is split into the
// closed-bucket `completed` cut and the forming-bar-inclusive `asOfView` cut (see FrozenView).
export function buildFrozenView(args: {
  primaryBars: Candle[];
  asOf: number;
  timeframes: Timeframe[];
  session: SessionTemplate;
  calendar?: SessionCalendar;
}): FrozenView {
  const { primaryBars, asOf, timeframes, session, calendar } = args;

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
        `buildFrozenView: "1d" is out of scope — the frozen view buckets intraday bars, and daily is a raw NT8 stream (read it from the cache directly). Pass a subset of 15m/30m/1h/2h/4h.`,
      );
    }
    const { completedBars, formingBar } = bucketAsOf(
      primary,
      asOf,
      PERIOD_SECONDS[tf],
      session,
      calendar,
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

// Bucket `primary` (already filtered to <= asOf) into `periodSeconds` buckets with the math core/aggregator.ts uses (core/buckets.ts), then split by bucket period-end vs asOf:
//  - period-end <= asOf → completed (safe for zone detection)
//  - period-end >  asOf → the single forming bar (live, for SMA / trend)
// Both are stamped with that period-end, so the forming bar is the one whose stamp is after asOf.
// Neither cut ever carries `partial`: which map a bar lands in says completed or live, and the private SMA reader rejects a flagged bar.
// A bucket's period-end is its natural grid close clamped to the session-day end, so a session's trailing stub 
// (e.g. CME ETH's 3-hour 14:00–17:00 4h bucket) counts as complete the instant asOf reaches the 17:00 session close, not at the unreachable 18:00 grid line.
function bucketAsOf(
  primary: readonly Candle[],
  asOf: number,
  periodSeconds: number,
  session: SessionTemplate,
  calendar?: SessionCalendar,
): AsOfBuckets {
  const buckets = new Map<string, { bars: Candle[]; periodEnd: number }>();
  const resolveDay = makeSessionDayResolver(session, calendar);

  for (const c of primary) {
    const sd = resolveDay(c.timestamp);
    // Bars outside any session-day (maintenance break / weekend gap) are dropped from HTF aggregation, exactly as core/aggregator.ts does.
    // They stay in `primary` (the raw entry-TF series) but never form an HTF bar.
    if (sd === null) continue;
    const index = bucketIndexOf(c.timestamp, sd.startUnix, periodSeconds);
    const key = `${sd.label}|${index}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        bars: [],
        periodEnd: bucketPeriodEnd(sd.startUnix, sd.endUnix, index, periodSeconds),
      };
      buckets.set(key, bucket);
    }
    bucket.bars.push(c);
  }

  const completedBars: Candle[] = [];
  let formingBar: Candle | null = null;

  for (const { bars, periodEnd } of buckets.values()) {
    bars.sort((a, b) => a.timestamp - b.timestamp);
    const candle = aggregateBucket(bars, periodEnd);
    // The period end — never markPartial / now — decides completed vs forming.
    if (periodEnd <= asOf) {
      completedBars.push(candle);
    } else if (formingBar === null || periodEnd > formingBar.timestamp) {
      // At most one bucket can straddle asOf: `primary` is pre-filtered to <= asOf, so any bucket after this one would be empty. 
      // The max-timestamp guard is belt-and-suspenders if that ever breaks.
      formingBar = candle;
    }
  }

  completedBars.sort((a, b) => a.timestamp - b.timestamp);
  return { completedBars, formingBar };
}
