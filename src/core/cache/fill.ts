import type { Database } from "better-sqlite3";
import type { Timeframe } from "../types.js";
import type { SessionDay, SessionTemplate } from "../sessions/types.js";
import { sessionDaysOverlapping } from "../sessions/session-day.js";
import {
  loadCalendar,
  recordObservedClose,
  type SessionCalendar,
} from "../sessions/calendar.js";
import { wallClockHHMM } from "../time.js";
import { getInstrumentConfig } from "../sessions/registry.js";
import { mismatchIsEmpty, validateSessionDay } from "./validator.js";
import { expectedRawGrid, purgeOffGridRawRows } from "./purge.js";
import { recomputeDerivedForSessionDay } from "./derived.js";

// Classification of a single session-day's cache state at a given raw TF.
//   complete    — bars match expected geometry, nothing to do
//   empty       — zero bars cached
//   partial     — some bars cached but structurally incomplete; refetch
//                 the whole day and overwrite (avoids mid-day join logic)
//   in_progress — session hasn't closed yet (endUnix > nowUnix); always
//                 refetched so the user's view of "today" stays fresh
export type SessionDayClass =
  | "complete"
  | "empty"
  | "partial"
  | "in_progress";

export interface DayClassification {
  day: SessionDay;
  class: SessionDayClass;
}

export function classifySessionDay(
  db: Database,
  symbol: string,
  day: SessionDay,
  rawTimeframe: Timeframe,
  nowUnix: number,
): SessionDayClass {
  const r = validateSessionDay(db, symbol, day, rawTimeframe, nowUnix);
  if (r.status === "skipped") return "in_progress";
  if (r.status === "ok") return "complete";
  return mismatchIsEmpty(r) ? "empty" : "partial";
}

export interface FetchWindow {
  startUnix: number;
  endUnix: number;
  labels: string[]; // session-day labels covered by this window, in order
}

/**
 * One fetch window per non-complete session-day — deliberately NOT
 * merged. A fresh month becomes ~22 small, sub-timeout,
 * independently-healable requests instead of one mega-request that blows
 * the bridge timeout when NT8 must first download history from the
 * provider; one slow or failed day no longer poisons the whole range.
 *
 * Non-session calendar days (Saturdays, etc.) are already absent from
 * the input list because `sessionDaysOverlapping` only yields valid
 * session-days.
 */
export function planFetchWindows(
  classifications: DayClassification[],
): FetchWindow[] {
  const windows: FetchWindow[] = [];
  for (const { day, class: cls } of classifications) {
    if (cls !== "complete") {
      windows.push({
        startUnix: day.startUnix,
        endUnix: day.endUnix,
        labels: [day.label],
      });
    }
  }
  return windows;
}

// Candle fetches get a wider timeout than the 10s bridge default: a cold
// window can force NT8 to download history from the data provider first.
// Even a fetch that outlives this timeout is not wasted — the late
// candles_response is ingested by the global handler in bridge/ingest.ts.
export const CANDLE_FETCH_TIMEOUT_MS = 30_000;

export interface EnsureCachedDeps {
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

export interface EnsureCachedResult {
  classifications: DayClassification[];
  windowsFetched: number;
  windowsFailed: number;
  fetchedDays: string[];
  errors: Array<{ window: string; message: string }>;
  // True iff at least one fetch was skipped because the bridge was
  // disconnected. Callers use this to surface the canonical "start
  // NT8 with the McpBridge addon" guidance in the response warning.
  bridgeDisconnected: boolean;
  // True iff a new early-close time was recorded in session_calendar this
  // call — callers must reload the calendar before validating geometry.
  calendarUpdated: boolean;
}

/**
 * Validate → plan → fetch orchestrator for the raw timeframe that backs
 * a `get_candles` request. Called BEFORE the terminal SELECT so the
 * cache reflects every requested session-day at the raw TF. Persistence
 * itself lives in the global candles_response handler (bridge/ingest.ts);
 * this loop only tracks which windows succeeded or failed.
 *
 * Day-aligned fetches: regardless of the user's intra-day window, the
 * fetch always covers `(sessionDay.startUnix, sessionDay.endUnix]` for
 * each session-day in a window. On re-ingest, CLOSED days converge to the
 * fresh fetch (guarded delete-then-insert in ingest's day-refill mode);
 * in-progress days merge via INSERT OR REPLACE.
 *
 * In-progress days are always refetched. The live bar_close ingest is
 * best-effort; refetching today on every query keeps the view fresh
 * without depending on stream reliability.
 */
export async function ensureCached(
  db: Database,
  symbol: string,
  startTs: number,
  endTs: number,
  rawTimeframe: Timeframe,
  template: SessionTemplate,
  deps: EnsureCachedDeps,
  nowUnix: number,
  calendar?: SessionCalendar,
): Promise<EnsureCachedResult> {
  // Calendar-aware enumeration: closed days don't exist; timed early-close
  // days carry adjusted geometry so they can classify complete.
  const days = sessionDaysOverlapping(startTs, endTs, template, calendar);
  const classifications: DayClassification[] = days.map((day) => ({
    day,
    class: classifySessionDay(db, symbol, day, rawTimeframe, nowUnix),
  }));
  const windows = planFetchWindows(classifications);

  const result: EnsureCachedResult = {
    classifications,
    windowsFetched: 0,
    windowsFailed: 0,
    fetchedDays: [],
    errors: [],
    bridgeDisconnected: false,
    calendarUpdated: false,
  };

  if (windows.length === 0) return result;

  if (!deps.isConnected()) {
    result.bridgeDisconnected = true;
    for (const w of windows) {
      result.windowsFailed++;
      result.errors.push({
        window: w.labels.join(","),
        message: "NinjaTrader not connected",
      });
    }
    return result;
  }

  const fetchedWindows: FetchWindow[] = [];
  for (const window of windows) {
    const day: SessionDay = {
      label: window.labels[0],
      startUnix: window.startUnix,
      endUnix: window.endUnix,
    };
    if (classifySessionDay(db, symbol, day, rawTimeframe, nowUnix) === "complete") {
      result.windowsFetched++;
      result.fetchedDays.push(...window.labels);
      continue;
    }

    try {
      // Pure success/fail signal — ingest is owned by the candles_response
      // handler (bridge/ingest.ts), which runs before this await resumes.
      // A timed-out request still heals late through that same handler.
      await deps.request(
        "request_candles",
        {
          symbol,
          timeframe: rawTimeframe,
          from: window.startUnix,
          to: window.endUnix,
          tradingHoursTemplate: template.name,
        },
        CANDLE_FETCH_TIMEOUT_MS,
      );
      result.windowsFetched++;
      result.fetchedDays.push(...window.labels);
      fetchedWindows.push(window);
    } catch (err) {
      result.windowsFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ window: window.labels.join(","), message: msg });
    }
  }

  // Record an early close before purging, so a genuine non-grid-aligned stub
  // isn't deleted before its close time is known. Reconcile here rather than
  // in ingest: only this side knows which window was fetched, so a zero-bar
  // response's leftovers converge to honest-empty instead of refetch-looping.
  for (const window of fetchedWindows) {
    const day: SessionDay = {
      label: window.labels[0],
      startUnix: window.startUnix,
      endUnix: window.endUnix,
    };
    if (
      calendar &&
      observeEarlyClose(db, symbol, rawTimeframe, day, template, calendar, nowUnix)
    ) {
      result.calendarUpdated = true;
      continue;
    }
    // Close time unrecorded, so the day's true grid is unknown: purging
    // against template geometry would delete the genuine stub bar.
    const calEntry = calendar?.get(day.label);
    if (calEntry?.kind === "modified" && !calEntry.closeTime) {
      continue;
    }
    if (rawTimeframe === "1d") continue; // no intraday grid to reconcile
    const grid = expectedRawGrid(day, rawTimeframe, template, calendar);
    const purged = purgeOffGridRawRows(db, symbol, rawTimeframe, day, grid, nowUnix);
    if (purged > 0) {
      console.error(
        `[fill] post-fetch reconcile ${symbol} ${rawTimeframe} ${day.label}: removed ${purged} off-grid row(s)`,
      );
      // Without re-deriving, the day would serve derived OHLCV aggregated
      // from the rows just deleted — at canonical stamps that pass every
      // validator.
      if (rawTimeframe === "15m") {
        const config = getInstrumentConfig(symbol);
        const cal = calendar ?? loadCalendar(db, template.name);
        db.transaction(() => {
          recomputeDerivedForSessionDay(db, symbol, day, config, cal, nowUnix);
        })();
      }
    }
  }

  return result;
}

/**
 * Record an observed early close for a declared-but-untimed modified day
 * whose cached bars end before the template close. Only declared dates,
 * only closed sessions, only a structurally clean prefix — internal gaps
 * stay loud mismatches. Returns true iff a time was recorded; callers must
 * then reload the calendar before re-deriving geometry.
 */
export function observeEarlyClose(
  db: Database,
  symbol: string,
  rawTimeframe: Timeframe,
  day: SessionDay,
  template: SessionTemplate,
  calendar: SessionCalendar,
  nowUnix: number,
): boolean {
  const entry = calendar.get(day.label);
  if (
    entry?.kind !== "modified" ||
    entry.closeTime ||
    entry.openTime ||
    day.endUnix > nowUnix
  ) {
    return false;
  }
  const { m } = db
    .prepare(
      `SELECT MAX(timestamp) AS m FROM candles
        WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?`,
    )
    .get(symbol, rawTimeframe, day.startUnix, day.endUnix) as { m: number | null };
  if (m === null || m >= day.endUnix) return false; // empty or normal-length
  const probe = validateSessionDay(
    db,
    symbol,
    { label: day.label, startUnix: day.startUnix, endUnix: m },
    rawTimeframe,
    nowUnix,
  );
  if (probe.status !== "ok") return false; // gap-riddled prefix — stay loud
  const closeHHMM = wallClockHHMM(m, template.timezone);
  const recorded = recordObservedClose(db, template.name, day.label, closeHHMM);
  if (recorded) {
    console.error(
      `[fill] observed early close for ${template.name} ${day.label}: ${closeHHMM} (recorded)`,
    );
  }
  return recorded;
}
