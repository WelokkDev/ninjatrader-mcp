import type { Candle, Timeframe } from "./types.js";
import type { AlignmentStrategy, SessionTemplate } from "./sessions/types.js";
import { sessionDayContaining } from "./sessions/session-day.js";

const PERIOD_MINUTES: Record<Timeframe, number> = {
  "5m": 5,
  "15m": 15,
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
}

/**
 * Aggregates 15-minute close-stamped candles into the target timeframe
 * using the instrument's session model.
 *
 * Output is close-stamped: each aggregated bar's `timestamp` is the
 * close-stamp of the LAST underlying 15-minute bar in its bucket, which
 * matches NT8's display convention (a 4h bucket Mon 18:00 → Mon 22:00 ET
 * is labeled 22:00).
 *
 */
export function aggregateCandles(
  candles: Candle[],
  targetTimeframe: Timeframe,
  options: AggregateOptions,
): Candle[] {
  if (targetTimeframe === "5m" || targetTimeframe === "15m") {
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
  const buckets = new Map<string, Candle[]>();

  for (const candle of candles) {
    const sd = sessionDayContaining(candle.timestamp, options.session);
    if (sd === null) {
      console.error(
        `[aggregator] dropping bar at ${candle.timestamp} — not in any session-day for template "${options.session.name}"`,
      );
      continue;
    }
    // CRITICAL: subtract 1 second from the close-stamp before flooring
    // so that boundary close-stamps (e.g. Tue 22:00 = the close of the
    // first 4h bucket on CME ETH) fall into the bucket their data window
    // belongs to, not the next one.
    //
    // DO NOT REMOVE the `- 1`. A simplification pass that deletes it as
    // dead arithmetic will silently shift every boundary close-stamp
    // into the wrong bucket.
    const bucketIndex = Math.floor(
      (candle.timestamp - sd.startUnix - 1) / periodSeconds,
    );
    const key = `${sd.label}|${bucketIndex}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(candle);
  }

  const result: Candle[] = [];
  for (const group of buckets.values()) {
    group.sort((a, b) => a.timestamp - b.timestamp);
    const last = group[group.length - 1];
    result.push({
      // Close-stamp of the LAST underlying bar = close-stamp of the
      // bucket. Matches NT8's display convention.
      timestamp: last.timestamp,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: last.close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  result.sort((a, b) => a.timestamp - b.timestamp);
  return markPartial(result, options);
}

function stripPartial(c: Candle): Candle {
  if (c.partial === undefined) return c;
  const { partial: _drop, ...rest } = c;
  return rest;
}

// Sets `partial: true` on the LAST candle in a sorted-ascending array
// when its containing session-day's expected end is in the future.
// Mutates the trailing entry in place (after a copy at the call site).
function markPartial(sorted: Candle[], options: AggregateOptions): Candle[] {
  if (sorted.length === 0) return sorted;
  const last = sorted[sorted.length - 1];
  const sd = sessionDayContaining(last.timestamp, options.session);
  if (sd === null) return sorted;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (sd.endUnix > now) {
    sorted[sorted.length - 1] = { ...last, partial: true };
  }
  return sorted;
}
