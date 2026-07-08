import type { Database } from "better-sqlite3";
import type { Timeframe } from "../types.js";
import type { SessionDay, SessionTemplate } from "../sessions/types.js";
import { sessionDaysOverlapping } from "../sessions/session-day.js";
import { validateSessionDay } from "./validator.js";

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
  if (r.actual.length === 0) return "empty";
  return "partial";
}

export interface FetchWindow {
  startUnix: number;
  endUnix: number;
  labels: string[]; // session-day labels covered by this window, in order
}

/**
 * One fetch window per non-complete session-day — deliberately NOT
 * merged (D-B2). A fresh month becomes ~22 small, sub-timeout,
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
 * each session-day in a window. Mid-day partial caches are dropped via
 * INSERT OR REPLACE on re-ingest.
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
): Promise<EnsureCachedResult> {
  const days = sessionDaysOverlapping(startTs, endTs, template);
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

  for (const window of windows) {
    try {
      // Pure success/fail signal. Ingest is owned by the global
      // candles_response handler (bridge/ingest.ts), which runs
      // synchronously inside the bridge's message dispatch — the cache is
      // already populated by the time this await resumes. On timeout the
      // request rejects, but a late response still heals via that same
      // handler, so the next query sees those days complete.
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
    } catch (err) {
      result.windowsFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ window: window.labels.join(","), message: msg });
    }
  }

  return result;
}
