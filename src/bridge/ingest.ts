import db from "../db/connection.js";
import { aggregateCandles } from "../core/aggregator.js";
import { RAW_TIMEFRAMES, SUPPORTED_TIMEFRAMES } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  sessionDayContaining,
  sessionDayRange,
} from "../core/sessions/session-day.js";
import type { Candle, Timeframe } from "../core/types.js";
import { onMessage } from "./index.js";

// TFs that are aggregated from 15m on the 15m ingest path. 5m bars do
// not feed this chain (5m is a parallel raw stream).
const DERIVED_TIMEFRAMES: Timeframe[] = SUPPORTED_TIMEFRAMES.filter(
  (tf) => !RAW_TIMEFRAMES.includes(tf),
);

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

export function ingestCandles(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
): IngestResult {
  if (!RAW_TIMEFRAMES.includes(timeframe)) {
    throw new Error(
      `ingestCandles: timeframe '${timeframe}' is not a raw TF — only ${RAW_TIMEFRAMES.join(", ")} can be ingested directly`,
    );
  }

  const valid: Candle[] = [];
  for (const c of candles) {
    if (isValidCandle(c)) {
      valid.push(c);
    } else {
      console.error(
        `[ingest] skipping invalid candle for ${symbol} ${timeframe}: ${JSON.stringify(c)}`,
      );
    }
  }

  const aggregated: Record<string, number> = Object.fromEntries(
    DERIVED_TIMEFRAMES.map((tf) => [tf, 0]),
  );

  if (valid.length === 0) return { inserted: 0, aggregated };

  const config = getInstrumentConfig(symbol);

  // Map each incoming bar to its session-day. Bars outside any session-day
  // (in maintenance breaks, weekend gaps, or pre-session) are dropped with
  // a warning rather than persisted.
  const inSession: Array<{ candle: Candle; sessionDayLabel: string }> = [];
  const affectedSessionDays = new Set<string>();
  for (const c of valid) {
    const sd = sessionDayContaining(c.timestamp, config.session);
    if (sd === null) {
      console.error(
        `[ingest] dropping bar for ${symbol} ${timeframe} at unix=${c.timestamp} — not in any session-day for template "${config.session.name}"`,
      );
      continue;
    }
    inSession.push({ candle: c, sessionDayLabel: sd.label });
    affectedSessionDays.add(sd.label);
  }

  if (inSession.length === 0) return { inserted: 0, aggregated };

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO candles
       (symbol, timeframe, timestamp, open, high, low, close, volume, indicators_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Only 15m bars drive the derived-TF aggregation cascade. SELECT all
  // 15m bars within a session-day's (startUnix, endUnix] range for
  // re-aggregation. Half-open in SQL maps to `> ? AND <= ?` per the
  // session-day boundary convention
  const selectSessionStmt = db.prepare(
    `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = '15m'
        AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC`,
  );

  const tx = db.transaction(() => {
    for (const { candle: c } of inSession) {
      const indJson = c.indicators ? JSON.stringify(c.indicators) : null;
      insertStmt.run(symbol, timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume, indJson);
    }

    // 5m is a raw, parallel stream — persisted and stopped. Only 15m
    // ingest fans out into the derived chain.
    if (timeframe !== "15m") return;

    for (const label of affectedSessionDays) {
      const range = sessionDayRange(label, config.session);
      const sessionCandles = selectSessionStmt.all(
        symbol,
        range.startUnix,
        range.endUnix,
      ) as Candle[];
      if (sessionCandles.length === 0) continue;

      for (const tf of DERIVED_TIMEFRAMES) {
        const aggCandles = aggregateCandles(sessionCandles, tf, {
          session: config.session,
          alignment: config.alignment,
          timestampConvention: config.timestampConvention,
        });
        for (const a of aggCandles) {
          insertStmt.run(symbol, tf, a.timestamp, a.open, a.high, a.low, a.close, a.volume, null);
        }
        aggregated[tf] += aggCandles.length;
      }
    }
  });

  tx();

  return { inserted: inSession.length, aggregated };
}

export function registerLiveIngestHandler(): void {
  onMessage("bar_close", (msg) => {
    try {
      const result = ingestCandles(
        msg.symbol,
        msg.timeframe as Timeframe,
        [msg.candle],
      );
      console.error(
        `[ingest] bar_close ${msg.symbol} ${msg.timeframe}: inserted=${result.inserted} agg=${JSON.stringify(result.aggregated)}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] bar_close ingest failed for ${msg.symbol} ${msg.timeframe}: ${m}`);
    }
  });
}
