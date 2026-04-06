import type { Candle, Timeframe } from "./types.js";
import { AGGREGATION_MAP } from "./constants.js";

const SESSION_START_MINUTES = 9 * 60 + 30; // 9:30 AM ET

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

function getETComponents(timestampSec: number): {
  date: string;
  minuteOfDay: number;
} {
  const parts = etFormatter.formatToParts(new Date(timestampSec * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const hour = parseInt(get("hour"));
  const minute = parseInt(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minuteOfDay: hour * 60 + minute,
  };
}

/**
 * Aggregates 15m candles into the target timeframe.
 *
 * Alignment rules:
 *   30m  — clock-aligned to :00, :30
 *   1h   — clock-aligned to the hour
 *   2h   — clock-aligned to even hours (10:00, 12:00, 14:00)
 *   4h   — session-aligned to 9:30, 13:30 (RTH boundaries)
 *
 * Never aggregates across day boundaries.
 * Incomplete groups at end-of-day are kept (not discarded).
 */
export function aggregateCandles(
  candles: Candle[],
  targetTimeframe: Timeframe,
): Candle[] {
  if (targetTimeframe === "15m") return [...candles];

  const periodMinutes = AGGREGATION_MAP[targetTimeframe] * 15;

  // Group candles into buckets keyed by (tradingDay, alignedBucketMinute)
  const buckets = new Map<string, Candle[]>();

  for (const candle of candles) {
    const { date, minuteOfDay } = getETComponents(candle.timestamp);

    let bucketMinute: number;
    if (targetTimeframe === "4h") {
      // Session-aligned: offset from 9:30 session start
      const sinceSession = minuteOfDay - SESSION_START_MINUTES;
      bucketMinute =
        SESSION_START_MINUTES +
        Math.floor(sinceSession / periodMinutes) * periodMinutes;
    } else {
      // Clock-aligned: floor to period boundary
      bucketMinute =
        Math.floor(minuteOfDay / periodMinutes) * periodMinutes;
    }

    const key = `${date}|${bucketMinute}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(candle);
  }

  // Aggregate each bucket into a single candle
  const result: Candle[] = [];
  for (const group of buckets.values()) {
    result.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return result.sort((a, b) => a.timestamp - b.timestamp);
}
