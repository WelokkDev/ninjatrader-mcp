import type { Database } from "better-sqlite3";
import { aggregateCandles } from "../aggregator.js";
import { isRawTimeframe, SUPPORTED_TIMEFRAMES } from "../constants.js";
import type { SessionCalendar } from "../sessions/calendar.js";
import type { InstrumentConfig, SessionDay } from "../sessions/types.js";
import type { Candle, DerivedTimeframe, Timeframe } from "../types.js";

// Aggregated from 15m on the 15m ingest path; other raw TFs are parallel
// streams and don't feed this chain.
export const DERIVED_TIMEFRAMES: DerivedTimeframe[] = SUPPORTED_TIMEFRAMES.filter(
  (tf): tf is DerivedTimeframe => !isRawTimeframe(tf),
);

/**
 * The derived-TF rows a session-day should hold, aggregated from its cached
 * 15m rows. Pure read — lets callers spot a no-op recompute before churning.
 */
export function computeDerivedForSessionDay(
  database: Database,
  symbol: string,
  day: SessionDay,
  config: InstrumentConfig,
  calendar: SessionCalendar,
  nowUnix?: number,
): Map<Timeframe, Candle[]> {
  const out = new Map<Timeframe, Candle[]>();
  const sessionCandles = database
    .prepare(
      `SELECT timestamp, open, high, low, close, volume
         FROM candles
        WHERE symbol = ? AND timeframe = '15m'
          AND timestamp > ? AND timestamp <= ?
        ORDER BY timestamp ASC`,
    )
    .all(symbol, day.startUnix, day.endUnix) as Candle[];
  for (const tf of DERIVED_TIMEFRAMES) {
    out.set(
      tf,
      sessionCandles.length === 0
        ? []
        : aggregateCandles(sessionCandles, tf, {
            session: config.session,
            alignment: config.alignment,
            timestampConvention: config.timestampConvention,
            calendar,
            ...(nowUnix !== undefined && { now: nowUnix }),
          }),
    );
  }
  return out;
}

/**
 * Replace one session-day's derived rows with a computed set. Not
 * transactional: the caller owns the transaction.
 */
export function writeDerivedForSessionDay(
  database: Database,
  symbol: string,
  day: SessionDay,
  computed: Map<Timeframe, Candle[]>,
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    DERIVED_TIMEFRAMES.map((tf) => [tf, 0]),
  );
  const placeholders = DERIVED_TIMEFRAMES.map(() => "?").join(", ");
  database
    .prepare(
      `DELETE FROM candles
        WHERE symbol = ? AND timeframe IN (${placeholders})
          AND timestamp > ? AND timestamp <= ?`,
    )
    .run(symbol, ...DERIVED_TIMEFRAMES, day.startUnix, day.endUnix);

  // Exactly one distinct value across the day's 15m rows propagates, else
  // NULL — a derived bar can't be more certain than what built it.
  const basisRows = database
    .prepare(
      `SELECT DISTINCT price_basis AS pb FROM candles
        WHERE symbol = ? AND timeframe = '15m'
          AND timestamp > ? AND timestamp <= ?`,
    )
    .all(symbol, day.startUnix, day.endUnix) as Array<{ pb: string | null }>;
  const priceBasis = basisRows.length === 1 ? basisRows[0].pb : null;

  // Contract inherits by the same one-distinct-value-or-NULL rule.
  const contractRows = database
    .prepare(
      `SELECT DISTINCT contract AS ct FROM candles
        WHERE symbol = ? AND timeframe = '15m'
          AND timestamp > ? AND timestamp <= ?`,
    )
    .all(symbol, day.startUnix, day.endUnix) as Array<{ ct: string | null }>;
  const contract = contractRows.length === 1 ? contractRows[0].ct : null;

  const insertStmt = database.prepare(
    `INSERT OR REPLACE INTO candles
       (symbol, timeframe, timestamp, open, high, low, close, volume, price_basis, contract)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [tf, aggCandles] of computed) {
    for (const a of aggCandles) {
      insertStmt.run(
        symbol, tf, a.timestamp, a.open, a.high, a.low, a.close, a.volume, priceBasis, contract,
      );
    }
    counts[tf] += aggCandles.length;
  }
  return counts;
}

/**
 * Recompute a session-day's derived rows from its cached 15m rows. Derived
 * state is a pure function of those rows, so a day with zero cached 15m rows
 * converges derived to empty — callers healing existing state must guard on
 * 15m presence first. Not transactional: the caller owns the transaction.
 */
export function recomputeDerivedForSessionDay(
  database: Database,
  symbol: string,
  day: SessionDay,
  config: InstrumentConfig,
  calendar: SessionCalendar,
  nowUnix?: number,
): Record<string, number> {
  return writeDerivedForSessionDay(
    database,
    symbol,
    day,
    computeDerivedForSessionDay(database, symbol, day, config, calendar, nowUnix),
  );
}
