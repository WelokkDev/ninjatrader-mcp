import type { Database } from "better-sqlite3";
import { getInstrumentConfig } from "../sessions/registry.js";
import { sessionDayRange } from "../sessions/session-day.js";
import { loadCalendar, type SessionCalendar } from "../sessions/calendar.js";
import type { SessionTemplate } from "../sessions/types.js";
import { describeBadDays, validateRangeComplete } from "./validator.js";

// Backtest data preflight. The walker loads 5m history over
// [rangeStart − lookbackDays, rangeEnd + resolve-buffer]; SMA/HTF context
// comes from the lookback window, so it is validated with the range. The
// trailing resolve buffer is deliberately not gated — incomplete
// resolution already surfaces as ambiguousExitTrades.

/** Mirrors DEFAULT_LOOKBACK_DAYS in
 *  src/private/decision/playing-field-orchestrator.ts — keep in sync;
 *  public core must not import private modules. */
export const FALLBACK_LOOKBACK_DAYS = 35;

export interface RangePreflightResult {
  ok: boolean;
  /** Human-readable failure detail, WITHOUT a remedy suffix. */
  detail?: string;
  /** Session-days in the backtest range still open at nowUnix. */
  inProgressDays: string[];
}

/**
 * Unix-range preflight shared by run_backtest and the lab launch path:
 * every closed session-day in the backtest range AND its lookback window
 * must be structurally complete at 5m.
 */
export function backtestRangePreflight(
  db: Database,
  symbol: string,
  template: SessionTemplate,
  rangeStart: number,
  rangeEnd: number,
  lookbackDays: number,
  nowUnix: number,
  calendar: SessionCalendar,
): RangePreflightResult {
  const main = validateRangeComplete(
    db, symbol, "5m", rangeStart, rangeEnd, template, nowUnix, calendar,
  );
  const lookback =
    lookbackDays > 0
      ? validateRangeComplete(
          db, symbol, "5m",
          rangeStart - lookbackDays * 86_400,
          rangeStart - 1,
          template, nowUnix, calendar,
        )
      : null;

  const pieces: string[] = [];
  if (main.badDays.length > 0) {
    pieces.push(`${describeBadDays(main.badDays, "5m")} in the backtest range`);
  }
  if (lookback && lookback.badDays.length > 0) {
    pieces.push(
      `${describeBadDays(lookback.badDays, "5m")} in the ${lookbackDays}-day lookback window before the range (needed for SMA/HTF context)`,
    );
  }

  return {
    ok: pieces.length === 0,
    ...(pieces.length > 0 && { detail: `Data preflight: ${pieces.join("; ")}.` }),
    inProgressDays: main.inProgressDays,
  };
}

export interface BacktestRangeSpec {
  symbol: string;
  startDay: string; // YYYY-MM-DD session-day label
  endDay: string;
  lookbackDays?: number;
}

/**
 * Label-based preflight for the lab launch path. Returns null when the
 * range is safe to walk, or a human-readable refusal. Stricter than
 * run_backtest — a detached experiment has no interactive escape hatch,
 * so an in-progress end day and any resolution failure refuse outright.
 */
export function backtestDataPreflight(
  db: Database,
  spec: BacktestRangeSpec,
  nowUnix: number = Math.floor(Date.now() / 1000),
): string | null {
  try {
    const config = getInstrumentConfig(spec.symbol);
    const calendar = loadCalendar(db, config.session.name);
    const start = sessionDayRange(spec.startDay, config.session, calendar);
    const end = sessionDayRange(spec.endDay, config.session, calendar);
    if (start.startUnix >= end.endUnix) {
      return `start session-day ${spec.startDay} is not before end session-day ${spec.endDay}`;
    }

    const r = backtestRangePreflight(
      db,
      spec.symbol,
      config.session,
      start.startUnix,
      end.endUnix,
      spec.lookbackDays ?? FALLBACK_LOOKBACK_DAYS,
      nowUnix,
      calendar,
    );
    if (r.inProgressDays.length > 0) {
      return `the range ends on in-progress session-day ${r.inProgressDays.join(", ")} — a detached experiment must end at the last CLOSED session-day`;
    }
    if (!r.ok) {
      return `${r.detail} A backtest over partial data silently produces wrong results. Fill the cache first (get_candles or prefetch_candles for ${spec.symbol} over the range), then retry.`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
