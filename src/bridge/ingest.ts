import type { Database } from "better-sqlite3";
import db from "../db/connection.js";
import { RAW_TIMEFRAMES } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  makeSessionDayResolver,
  sessionDayRange,
} from "../core/sessions/session-day.js";
import { loadCalendar } from "../core/sessions/calendar.js";
import { expectedRawGrid, purgeOffGridRawRows } from "../core/cache/purge.js";
import {
  DERIVED_TIMEFRAMES,
  recomputeDerivedForSessionDay,
} from "../core/cache/derived.js";
import type { SessionDay } from "../core/sessions/types.js";
import type { Candle, Timeframe } from "../core/types.js";
import { onMessage } from "./index.js";
import { isSimulatedFeed } from "./data-source.js";
import type { CandlesResponseMessage } from "./protocol.js";

// Exported: the live runtime applies the same gate before /feed publish.
export function isValidCandle(c: Candle): boolean {
  return (
    Number.isInteger(c.timestamp) &&
    c.timestamp > 0 &&
    Number.isFinite(c.open) && c.open > 0 &&
    Number.isFinite(c.high) && c.high > 0 &&
    Number.isFinite(c.low) && c.low > 0 &&
    Number.isFinite(c.close) && c.close > 0 &&
    Number.isFinite(c.volume) && c.volume >= 0 &&
    // OHLC ordering: the body must sit inside the range.
    c.low <= Math.min(c.open, c.close) &&
    Math.max(c.open, c.close) <= c.high
  );
}

export interface IngestResult {
  inserted: number;
  // Invalid OHLCV, outside any session-day, or off a closed day's grid.
  dropped: number;
  aggregated: Record<string, number>;
}

export interface IngestOptions {
  // "day-refill" (whole-day fetch) deletes off-grid raw rows on the closed
  // days it touches; "append" (bar_close, direct callers) never deletes.
  mode?: "day-refill" | "append";
  nowUnix?: number;
}

export function ingestCandles(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  // Injectable for tests; production callers use the shared connection.
  database: Database = db,
  opts: IngestOptions = {},
): IngestResult {
  if (!RAW_TIMEFRAMES.includes(timeframe)) {
    throw new Error(
      `ingestCandles: timeframe '${timeframe}' is not a raw TF — only ${RAW_TIMEFRAMES.join(", ")} can be ingested directly`,
    );
  }

  let dropped = 0;
  const valid: Candle[] = [];
  for (const c of candles) {
    if (isValidCandle(c)) {
      valid.push(c);
    } else {
      dropped++;
      console.error(
        `[ingest] skipping invalid candle for ${symbol} ${timeframe}: ${JSON.stringify(c)}`,
      );
    }
  }

  const aggregated: Record<string, number> = Object.fromEntries(
    DERIVED_TIMEFRAMES.map((tf) => [tf, 0]),
  );

  if (valid.length === 0) return { inserted: 0, dropped, aggregated };

  const config = getInstrumentConfig(symbol);
  const calendar = loadCalendar(database, config.session.name);
  const mode = opts.mode ?? "append";
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);

  const inSession: Array<{ candle: Candle; sessionDayLabel: string }> = [];
  const perDayCount = new Map<string, number>();
  const resolveDay = makeSessionDayResolver(config.session, calendar);
  for (const c of valid) {
    const sd = resolveDay(c.timestamp);
    if (sd === null) {
      dropped++;
      console.error(
        `[ingest] dropping bar for ${symbol} ${timeframe} at unix=${c.timestamp} — not in any session-day for template "${config.session.name}"`,
      );
      continue;
    }
    inSession.push({ candle: c, sessionDayLabel: sd.label });
    perDayCount.set(sd.label, (perDayCount.get(sd.label) ?? 0) + 1);
  }

  if (inSession.length === 0) return { inserted: 0, dropped, aggregated };

  const insertStmt = database.prepare(
    `INSERT OR REPLACE INTO candles
       (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  // Doubles as a screen on incoming bars, so a mis-stamped bar the provider
  // keeps re-sending can't be re-planted after each purge.
  const closedDayGrid = new Map<string, Set<number>>();

  const tx = database.transaction(() => {
    // Off-grid rows are structural extras (partial-bucket leftovers,
    // mis-stamps). Canonical rows are never deleted, so a truncated or
    // stamp-disjoint fetch can't destroy real bars. In-progress days are
    // never touched: a lagging refill must not erase newer live bars.
    if (mode === "day-refill") {
      for (const label of perDayCount.keys()) {
        const range = sessionDayRange(label, config.session, calendar);
        const day: SessionDay = { label, ...range };
        if (range.endUnix > nowUnix) continue; // in-progress: never delete
        // Close time unknown, so the day's true grid is too. Purging against
        // the template close would delete the genuine early-close stub bar
        // that observeEarlyClose still needs to see. Converges once a close
        // time is recorded.
        const calEntry = calendar.get(label);
        if (calEntry?.kind === "modified" && !calEntry.closeTime) {
          continue;
        }
        const expectedSet = expectedRawGrid(
          day,
          timeframe as Exclude<Timeframe, "1d">,
          config.session,
          calendar,
        );
        closedDayGrid.set(label, expectedSet);
        const removed = purgeOffGridRawRows(database, symbol, timeframe, day, expectedSet, nowUnix);
        if (removed > 0) {
          console.error(
            `[ingest] day-refill ${symbol} ${timeframe} ${label}: removed ${removed} off-grid row(s)`,
          );
        }
      }
    }

    for (const { candle: c, sessionDayLabel } of inSession) {
      const grid = closedDayGrid.get(sessionDayLabel);
      if (grid && !grid.has(c.timestamp)) {
        dropped++;
        console.error(
          `[ingest] dropping off-grid bar for ${symbol} ${timeframe} at unix=${c.timestamp} — closed day ${sessionDayLabel} converges to its expected grid`,
        );
        continue;
      }
      insertStmt.run(symbol, timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume);
      inserted++;
    }

    // Only 15m fans out into the derived chain; other raw TFs are parallel
    // streams. Recomputed per day from scratch, so partial-bucket rows from
    // mid-session ingests can't accumulate.
    if (timeframe !== "15m") return;

    for (const label of perDayCount.keys()) {
      const range = sessionDayRange(label, config.session, calendar);
      const counts = recomputeDerivedForSessionDay(
        database, symbol, { label, ...range }, config, calendar, nowUnix,
      );
      for (const tf of DERIVED_TIMEFRAMES) aggregated[tf] += counts[tf];
    }
  });

  tx();

  return { inserted, dropped, aggregated };
}

/**
 * The single owner of historical-candle persistence. Runs on every
 * candles_response, including ones whose request already timed out — a late
 * response still lands in the cache, so the next query sees those days
 * complete instead of refetching from zero.
 */
export function createCandlesResponseHandler(database: Database = db) {
  return (msg: CandlesResponseMessage): void => {
    // Real-data-only cache: reject sim-feed bars before they reach SQLite.
    if (isSimulatedFeed(msg.dataSource)) {
      console.error(
        `[ingest] REJECTED ${msg.candles.length} candle(s) for ${msg.symbol} ${msg.timeframe} — served by the Simulated Data Feed (synthetic; never cached)`,
      );
      return;
    }
    try {
      const result = ingestCandles(
        msg.symbol,
        msg.timeframe as Timeframe,
        msg.candles,
        database,
        { mode: "day-refill" },
      );
      console.error(
        `[ingest] candles_response ${msg.symbol} ${msg.timeframe}: inserted=${result.inserted} dropped=${result.dropped} agg=${JSON.stringify(result.aggregated)}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(
        `[ingest] candles_response ingest failed for ${msg.symbol} ${msg.timeframe}: ${m}`,
      );
    }
  };
}

export function registerCandlesResponseHandler(): void {
  onMessage("candles_response", createCandlesResponseHandler());
}

export function registerLiveIngestHandler(): void {
  onMessage("bar_close", (msg) => {
    // Same quarantine as the historical path.
    if (isSimulatedFeed(msg.dataSource)) {
      console.error(
        `[ingest] REJECTED live bar for ${msg.symbol} ${msg.timeframe} — served by the Simulated Data Feed (synthetic; never cached)`,
      );
      return;
    }
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
