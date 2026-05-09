import db from "../db/connection.js";
import { aggregateCandles } from "../core/aggregator.js";
import { SUPPORTED_TIMEFRAMES } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  sessionDayContaining,
  sessionDayRange,
} from "../core/sessions/session-day.js";
import type { Candle, Timeframe } from "../core/types.js";
import { onMessage } from "./index.js";

const HIGHER_TIMEFRAMES: Timeframe[] = SUPPORTED_TIMEFRAMES.filter(
  (tf) => tf !== "15m",
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

  if (valid.length === 0) return { inserted: 0, aggregated };

  // Throws on unknown symbol — by design (see registry / design A.7).
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
        `[ingest] dropping bar for ${symbol} at unix=${c.timestamp} — not in any session-day for template "${config.session.name}"`,
      );
      continue;
    }
    inSession.push({ candle: c, sessionDayLabel: sd.label });
    affectedSessionDays.add(sd.label);
  }

  if (inSession.length === 0) return { inserted: 0, aggregated };

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO candles
       (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // SELECT all 15m bars within a session-day's (startUnix, endUnix]
  // range. Note: half-open in SQL maps to `> ? AND <= ?` to match the
  // session-day boundary convention from design D.2 / D.6.
  const selectSessionStmt = db.prepare(
    `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = '15m'
        AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC`,
  );

  const tx = db.transaction(() => {
    for (const { candle: c } of inSession) {
      insertStmt.run(symbol, "15m", c.timestamp, c.open, c.high, c.low, c.close, c.volume);
    }

    for (const label of affectedSessionDays) {
      const range = sessionDayRange(label, config.session);
      const sessionCandles = selectSessionStmt.all(
        symbol,
        range.startUnix,
        range.endUnix,
      ) as Candle[];
      if (sessionCandles.length === 0) continue;

      for (const tf of HIGHER_TIMEFRAMES) {
        const aggCandles = aggregateCandles(sessionCandles, tf, {
          session: config.session,
          alignment: config.alignment,
          timestampConvention: config.timestampConvention,
        });
        for (const a of aggCandles) {
          insertStmt.run(symbol, tf, a.timestamp, a.open, a.high, a.low, a.close, a.volume);
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
