import type { Database } from "better-sqlite3";
import type { Candle, Timeframe } from "../types.js";
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
 * Groups consecutive non-complete session-days into contiguous fetch
 * windows. Complete days act as separators — a complete day between
 * two incomplete days produces two windows, not one merged window.
 *
 * Non-session calendar days (Saturdays, etc.) are already absent from
 * the input list because `sessionDaysOverlapping` only yields valid
 * session-days. The maintenance gap between adjacent session-days
 * (17:00→18:00 ET on CME ETH) is absorbed into the merged window —
 * NT8 returns no bars for that hour anyway.
 */
export function planFetchWindows(
  classifications: DayClassification[],
): FetchWindow[] {
  const windows: FetchWindow[] = [];
  let current: FetchWindow | null = null;

  for (const { day, class: cls } of classifications) {
    const needsFetch = cls !== "complete";
    if (needsFetch) {
      if (current === null) {
        current = {
          startUnix: day.startUnix,
          endUnix: day.endUnix,
          labels: [day.label],
        };
      } else {
        current.endUnix = day.endUnix;
        current.labels.push(day.label);
      }
    } else if (current !== null) {
      windows.push(current);
      current = null;
    }
  }
  if (current !== null) windows.push(current);
  return windows;
}

export interface EnsureCachedDeps {
  isConnected: () => boolean;
  request: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  ingestCandles: (
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
  ) => unknown;
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
 * Validate → plan → fetch → ingest orchestrator for the raw timeframe
 * that backs a `get_candles` request. Called BEFORE the terminal SELECT
 * so the cache reflects every requested session-day at the raw TF.
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
      const response = (await deps.request("request_candles", {
        symbol,
        timeframe: rawTimeframe,
        from: window.startUnix,
        to: window.endUnix,
        tradingHoursTemplate: template.name,
      })) as { candles?: Candle[] };

      const fetched: Candle[] = (response.candles ?? []).map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      deps.ingestCandles(symbol, rawTimeframe, fetched);
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
