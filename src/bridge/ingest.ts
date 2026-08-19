import type { Database } from "better-sqlite3";
import db from "../db/connection.js";
import { isRawTimeframe, RAW_TIMEFRAMES } from "../core/constants.js";
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
import {
  describeReconcileMismatch,
  normalizeDailyStamps,
  reconcileDailyAgainstIntraday,
  summarizeConventions,
  type DailyReconcileResult,
} from "../core/cache/daily.js";
import type { SessionDay } from "../core/sessions/types.js";
import type { Candle, Timeframe } from "../core/types.js";
import { onMessage } from "./index.js";
import { isSimulatedFeed } from "./data-source.js";
import { contractForLabel, loadRolloverWindows } from "./contract-windows.js";
import type { BarCloseMessage, CandlesResponseMessage } from "./protocol.js";

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
  // "1d" only: session-days whose ingested daily bar disagreed with the
  // intraday bars already cached for that same day. Non-empty means the daily
  // stream is filed against the wrong sessions (or the wrong contract) — the
  // rows are still written, but nothing downstream should trust them yet.
  dailyMismatches?: DailyReconcileResult[];
}

export interface IngestOptions {
  // "day-refill" (whole-day fetch) deletes off-grid raw rows on the closed
  // days it touches; "append" (bar_close, direct callers) never deletes.
  mode?: "day-refill" | "append";
  nowUnix?: number;
  // Basis the bridge reported for these bars ('as_traded' | 'back_adjusted' |
  // 'unknown'), from the merge policy that served the fetch. Stored per row so
  // a merge-policy change is visible instead of silently mixing two price
  // series. Undefined leaves the column NULL, which reads as unknown.
  priceBasis?: string;
  // NT8 FullName, per session-DAY: one merged fetch can span a roll and serve
  // a different contract each side of it.
  contractForDay?: (sessionDayLabel: string) => string | null;
}

export function ingestCandles(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  // Injectable for tests; production callers use the shared connection.
  database: Database = db,
  opts: IngestOptions = {},
): IngestResult {
  if (!isRawTimeframe(timeframe)) {
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

  // Daily bars carry whatever stamp NT8's provider uses; the cache stores one
  // canonical stamp — the session close. Re-stamp first, then let the shared
  // path below place them exactly like any other raw bar.
  let toPlace: readonly Candle[] = valid;
  let normalizedDaily: ReturnType<typeof normalizeDailyStamps>["bars"] = [];
  if (timeframe === "1d") {
    const norm = normalizeDailyStamps(valid, resolveDay);
    normalizedDaily = norm.bars;
    toPlace = norm.bars.map((b) => b.candle);
    for (const c of norm.unresolved) {
      dropped++;
      console.error(
        `[ingest] dropping 1d bar for ${symbol} at unix=${c.timestamp} — in no session-day for template "${config.session.name}"`,
      );
    }
    if (norm.bars.length > 0) {
      const restamped = norm.bars.filter((b) => b.convention !== "session_close").length;
      console.error(
        `[ingest] 1d stamp convention for ${symbol}: ${summarizeConventions(norm.bars)}` +
          (restamped > 0 ? ` (${restamped} bar(s) re-stamped onto the session close)` : ""),
      );
    }
  }

  for (const c of toPlace) {
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

  // 'unknown' is stored as NULL — a literal "unknown" would group as if it
  // were a basis of its own.
  const priceBasis =
    opts.priceBasis && opts.priceBasis !== "unknown" ? opts.priceBasis : null;

  const insertStmt = database.prepare(
    `INSERT OR REPLACE INTO candles
       (symbol, timeframe, timestamp, open, high, low, close, volume, price_basis, contract)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const contractByDay = new Map<string, string | null>();
  for (const label of perDayCount.keys()) {
    contractByDay.set(label, opts.contractForDay?.(label) ?? null);
  }

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
        const expectedSet = expectedRawGrid(day, timeframe, config.session, calendar);
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
      insertStmt.run(
        symbol, timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume, priceBasis,
        contractByDay.get(sessionDayLabel) ?? null,
      );
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

  // Re-stamping put each daily bar on a session-day; this proves it was the
  // RIGHT one. A bar filed against the wrong session cannot match that
  // session's own intraday open/high/low/close.
  const dailyMismatches: DailyReconcileResult[] = [];
  if (timeframe === "1d") {
    let checked = 0;
    for (const b of normalizedDaily) {
      const r = reconcileDailyAgainstIntraday(database, symbol, b.day, b.candle, nowUnix);
      if (r.against === null) continue;
      checked++;
      if (r.mismatches.length > 0) dailyMismatches.push(r);
    }
    if (dailyMismatches.length > 0) {
      const head = dailyMismatches.slice(0, 3).map(describeReconcileMismatch).join("; ");
      const more = dailyMismatches.length > 3 ? ` …and ${dailyMismatches.length - 3} more` : "";
      console.error(
        `[ingest] 1d RECONCILE FAILED for ${symbol}: ${dailyMismatches.length}/${checked} day(s) disagree with their cached intraday bars — ${head}${more}. ` +
          `The daily stream may be filed against the wrong sessions (NT8 stamp convention) or a different contract. Do NOT trust 1d for this symbol until this is resolved.`,
      );
    } else if (checked > 0) {
      console.error(
        `[ingest] 1d reconciled clean for ${symbol}: ${checked} day(s) match their cached intraday OHLC`,
      );
    }
  }

  return {
    inserted,
    dropped,
    aggregated,
    ...(dailyMismatches.length > 0 && { dailyMismatches }),
  };
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
      // The mirror is the attestation. msg.contract names only the current
      // window, so a disagreement is logged, never trusted over the mirror.
      const windows = loadRolloverWindows(database, msg.symbol);
      // Newest, not first: days iterate ascending and the oldest is expected
      // to mismatch, so a first-hit latch would hide a divergence on TODAY.
      let newestMismatch: { label: string; fromMirror: string } | null = null;
      const result = ingestCandles(
        msg.symbol,
        msg.timeframe as Timeframe,
        msg.candles,
        database,
        {
          mode: "day-refill",
          priceBasis: msg.priceBasis,
          contractForDay: (label) => {
            const fromMirror = contractForLabel(windows, msg.symbol, label);
            if (fromMirror !== null && msg.contract !== undefined && msg.contract !== fromMirror) {
              newestMismatch = { label, fromMirror };
            }
            return fromMirror;
          },
        },
      );
      if (newestMismatch !== null) {
        const { label, fromMirror } = newestMismatch;
        console.error(
          `[ingest] contract cross-check for ${msg.symbol} ${label}: mirror says ${fromMirror}, AddOn resolved ${msg.contract} — expected for days outside the current window; investigate if this names TODAY`,
        );
      }
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

/** Live counterpart of createCandlesResponseHandler, over an injectable DB. */
export function createBarCloseHandler(database: Database = db) {
  return (msg: BarCloseMessage): void => {
    // Same quarantine as the historical path.
    if (isSimulatedFeed(msg.dataSource)) {
      console.error(
        `[ingest] REJECTED live bar for ${msg.symbol} ${msg.timeframe} — served by the Simulated Data Feed (synthetic; never cached)`,
      );
      return;
    }
    try {
      const windows = loadRolloverWindows(database, msg.symbol);
      const result = ingestCandles(
        msg.symbol,
        msg.timeframe as Timeframe,
        [msg.candle],
        database,
        // Shares the candles table with historical fetches, so it must carry
        // the same basis label the AddOn computed per batch.
        {
          priceBasis: msg.priceBasis,
          // msg.contract only, never the mirror: every bar_close is a trade of
          // the subscribed instrument (even a stale `backfill` catch-up), so a
          // mirror label would launder old-contract bars into the new era
          // across a roll. Mismatches log; the splice enforces, not ingest.
          contractForDay: (label) => {
            const fromMirror = contractForLabel(windows, msg.symbol, label);
            const fromSub = msg.contract ?? null;
            if (fromSub !== null && fromMirror !== null && fromSub !== fromMirror) {
              console.error(
                `[ingest] bar_close contract mismatch for ${msg.symbol} ${label}: subscription serves ${fromSub}, mirror window says ${fromMirror} — NT8's continuous series has rolled but this subscription has not; its bars are the OLD contract until resubscribe`,
              );
            }
            return fromSub;
          },
        },
      );
      console.error(
        `[ingest] bar_close ${msg.symbol} ${msg.timeframe}: inserted=${result.inserted} agg=${JSON.stringify(result.aggregated)}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] bar_close ingest failed for ${msg.symbol} ${msg.timeframe}: ${m}`);
    }
  };
}

export function registerLiveIngestHandler(): void {
  onMessage("bar_close", createBarCloseHandler());
}
