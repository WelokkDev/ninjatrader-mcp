import db from "../db/connection.js";
import { aggregateCandles } from "../core/aggregator.js";
import { SUPPORTED_TIMEFRAMES } from "../core/constants.js";
import type { Candle, Timeframe } from "../core/types.js";
import { onMessage } from "./index.js";

const ET_TZ = "America/New_York";
const HIGHER_TIMEFRAMES: Timeframe[] = SUPPORTED_TIMEFRAMES.filter(
  (tf) => tf !== "15m",
);

const etDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: ET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const etPartsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function etDateOf(unixSec: number): string {
  // en-CA gives YYYY-MM-DD format reliably.
  return etDateFmt.format(new Date(unixSec * 1000));
}

// Returns the [start, endExclusive) Unix-second range for an ET calendar day.
// Handles DST by computing the wall-clock-vs-UTC offset at noon UTC of the
// target day (always lands on the same ET date in either EST or EDT).
function etDayRangeUnix(etDate: string): { start: number; endExclusive: number } {
  const [y, m, d] = etDate.split("-").map(Number);
  const probeUtcMs = Date.UTC(y, m - 1, d, 17, 0, 0); // 17:00 UTC
  const parts = etPartsFmt.formatToParts(new Date(probeUtcMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const etAsUtcMs = Date.UTC(
    parseInt(get("year")),
    parseInt(get("month")) - 1,
    parseInt(get("day")),
    parseInt(get("hour")),
    parseInt(get("minute")),
    parseInt(get("second")),
  );
  const offsetMs = etAsUtcMs - probeUtcMs; // negative for ET (UTC-4 / UTC-5)
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
  const endMs = Date.UTC(y, m - 1, d + 1, 0, 0, 0) - offsetMs;
  return {
    start: Math.floor(startMs / 1000),
    endExclusive: Math.floor(endMs / 1000),
  };
}

function isValidCandle(c: Candle): boolean {
  return (
    Number.isInteger(c.timestamp) &&
    c.timestamp > 0 &&
    Number.isFinite(c.open) && c.open > 0 &&
    Number.isFinite(c.high) && c.high > 0 &&
    Number.isFinite(c.low) && c.low > 0 &&
    Number.isFinite(c.close) && c.close > 0 &&
    Number.isFinite(c.volume) && c.volume >= 0
  );
}

export interface IngestResult {
  inserted: number;
  aggregated: Record<string, number>;
}

export function ingestCandles(symbol: string, candles: Candle[]): IngestResult {
  const valid: Candle[] = [];
  for (const c of candles) {
    if (isValidCandle(c)) {
      valid.push(c);
    } else {
      console.error(
        `[ingest] skipping invalid candle for ${symbol}: ${JSON.stringify(c)}`,
      );
    }
  }

  const aggregated: Record<string, number> = Object.fromEntries(
    HIGHER_TIMEFRAMES.map((tf) => [tf, 0]),
  );

  if (valid.length === 0) {
    return { inserted: 0, aggregated };
  }

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO candles
       (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const selectDayStmt = db.prepare(
    `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = '15m'
        AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC`,
  );

  const affectedDays = new Set<string>();
  for (const c of valid) {
    affectedDays.add(etDateOf(c.timestamp));
  }

  const tx = db.transaction(() => {
    for (const c of valid) {
      insertStmt.run(symbol, "15m", c.timestamp, c.open, c.high, c.low, c.close, c.volume);
    }

    for (const day of affectedDays) {
      const { start, endExclusive } = etDayRangeUnix(day);
      const dayCandles = selectDayStmt.all(symbol, start, endExclusive) as Candle[];
      if (dayCandles.length === 0) continue;

      for (const tf of HIGHER_TIMEFRAMES) {
        const aggCandles = aggregateCandles(dayCandles, tf);
        for (const a of aggCandles) {
          insertStmt.run(symbol, tf, a.timestamp, a.open, a.high, a.low, a.close, a.volume);
        }
        aggregated[tf] += aggCandles.length;
      }
    }
  });

  tx();

  return { inserted: valid.length, aggregated };
}

export function registerLiveIngestHandler(): void {
  onMessage("bar_close", (msg) => {
    try {
      const result = ingestCandles(msg.symbol, [msg.candle]);
      console.error(
        `[ingest] bar_close ${msg.symbol} ${msg.timeframe}: inserted=${result.inserted} agg=${JSON.stringify(result.aggregated)}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] bar_close ingest failed for ${msg.symbol}: ${m}`);
    }
  });
}
