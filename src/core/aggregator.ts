import type { Candle, DerivedTimeframe, Timeframe } from "./types.js";
import { bucketIndexOf, bucketPeriodEnd } from "./buckets.js";
import { isRawTimeframe } from "./constants.js";
import type { AlignmentStrategy, SessionTemplate } from "./sessions/types.js";
import type { SessionCalendar } from "./sessions/calendar.js";
import {
  makeSessionDayResolver,
  type SessionDayResolver,
} from "./sessions/session-day.js";

// Derived targets only: "1d" is excluded (see core/constants.ts header)
// and the raw streams (1s/5s/15s/5m/15m) short-circuit before this map is read.
const PERIOD_MINUTES: Record<DerivedTimeframe, number> = {
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
};

export interface AggregateOptions {
  session: SessionTemplate;
  alignment: AlignmentStrategy;
  timestampConvention: "close-stamped";
  // Used to mark partial bars. Defaults to Date.now()/1000. Tests can pin
  // it for deterministic partial-bar behavior.
  now?: number;
  // Session-calendar exceptions: affects bucket origin on late-begin days
  // and partial-marking on early-close days.
  calendar?: SessionCalendar;
}

/**
 * Aggregates 15-minute close-stamped candles into the target timeframe
 * using the instrument's session model.
 *
 * Output is close-stamped the way NT8 stamps it: every bucket carries its
 * period end (the 4h bucket Mon 18:00 → Mon 22:00 ET is labeled 22:00),
 * whichever of its 15m slots traded. The bucket still forming carries it
 * too, so its stamp is in the future until the period ends.
 */
export function aggregateCandles(
  candles: Candle[],
  targetTimeframe: Timeframe,
  options: AggregateOptions,
): Candle[] {
  if (targetTimeframe === "1d") {
    throw new Error(
      `aggregateCandles: target "1d" is not derived — daily is a RAW stream fetched from NT8 (one bar per session-day, close-stamped at the session end). Fetch it via get_candles/prefetch_candles instead of aggregating.`,
    );
  }
  if (isRawTimeframe(targetTimeframe)) {
    return markPartial([...candles].map(stripPartial), options);
  }

  if (
    options.alignment !== "session_aligned_with_stubs" &&
    options.alignment !== "wall_clock_utc"
  ) {
    // wall_clock_utc is implemented via the session-day model with a
    // daily-UTC template (CONTINUOUS_24_7)
    throw new Error(
      `aggregateCandles: alignment "${options.alignment}" is not implemented`,
    );
  }

  const periodSeconds = PERIOD_MINUTES[targetTimeframe] * 60;
  const buckets = new Map<string, { bars: Candle[]; periodEnd: number }>();
  const resolveDay = makeSessionDayResolver(options.session, options.calendar);

  for (const candle of candles) {
    const sd = resolveDay(candle.timestamp);
    if (sd === null) {
      console.error(
        `[aggregator] dropping bar at ${candle.timestamp} — not in any session-day for template "${options.session.name}"`,
      );
      continue;
    }
    const index = bucketIndexOf(candle.timestamp, sd.startUnix, periodSeconds);
    const key = `${sd.label}|${index}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        bars: [],
        periodEnd: bucketPeriodEnd(sd.startUnix, sd.endUnix, index, periodSeconds),
      };
      buckets.set(key, bucket);
    }
    bucket.bars.push(candle);
  }

  const result: Candle[] = [];
  for (const { bars, periodEnd } of buckets.values()) {
    bars.sort((a, b) => a.timestamp - b.timestamp);
    result.push(aggregateBucket(bars, periodEnd));
  }

  result.sort((a, b) => a.timestamp - b.timestamp);
  return markPartial(result, options, resolveDay);
}

/** One bucket's bars, ascending, reduced to a single candle stamped `timestamp`. */
export function aggregateBucket(group: readonly Candle[], timestamp: number): Candle {
  const last = group[group.length - 1];
  return {
    timestamp,
    open: group[0].open,
    high: Math.max(...group.map((c) => c.high)),
    low: Math.min(...group.map((c) => c.low)),
    close: last.close,
    volume: group.reduce((sum, c) => sum + c.volume, 0),
  };
}

function stripPartial(c: Candle): Candle {
  if (c.partial === undefined) return c;
  const { partial: _drop, ...rest } = c;
  return rest;
}

// Sets `partial: true` on the LAST candle in a sorted-ascending array
// when its containing session-day's expected end is in the future.
// Mutates the trailing entry in place (after a copy at the call site).
//
// Advisory and in-memory only — never persisted. It deliberately differs
// from the grid-membership rule used for served data: this also flags a
// trailing bucket that closed exactly on its boundary mid-session.
function markPartial(
  sorted: Candle[],
  options: AggregateOptions,
  resolveDay: SessionDayResolver = makeSessionDayResolver(options.session, options.calendar),
): Candle[] {
  if (sorted.length === 0) return sorted;
  const last = sorted[sorted.length - 1];
  const sd = resolveDay(last.timestamp);
  if (sd === null) return sorted;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (sd.endUnix > now) {
    sorted[sorted.length - 1] = { ...last, partial: true };
  }
  return sorted;
}
