import type { Database } from "better-sqlite3";
import type { SessionDay, SessionTemplate } from "../sessions/types.js";
import type { SessionCalendar } from "../sessions/calendar.js";
import type { Timeframe } from "../types.js";
import { sessionDaysOverlapping } from "../sessions/session-day.js";

// "1d" is excluded — the SQLite cache holds only intraday bars; daily bars are sourced on demand
const SECONDS_PER_TIMEFRAME: Record<Exclude<Timeframe, "1d">, number> = {
  "15s": 15,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
};

/**
 * Expected bar count for one (session-day, timeframe) from pure session
 * geometry: full periods within (startUnix, endUnix] plus a trailing stub
 * bar when the period doesn't evenly divide the session duration. Shared
 * by validateSessionDay, the get_candles fail-closed gate, and
 * resolve_session_days' barCountEstimate so all three speak the same geometry.
 */
export function expectedBarCount(
  sd: Pick<SessionDay, "startUnix" | "endUnix">,
  tf: Exclude<Timeframe, "1d">,
): number {
  const period = SECONDS_PER_TIMEFRAME[tf];
  const duration = sd.endUnix - sd.startUnix;
  return Math.floor(duration / period) + (duration % period !== 0 ? 1 : 0);
}

/**
 * The close-stamps session geometry demands for one (session-day, timeframe):
 * full periods from the session start, plus a stub at the close when the
 * period doesn't divide the duration. Works off resolved unix bounds, so
 * calendar-adjusted days get their adjusted stub automatically.
 */
export function expectedCloseStamps(
  sd: Pick<SessionDay, "startUnix" | "endUnix">,
  tf: Exclude<Timeframe, "1d">,
): number[] {
  const periodSeconds = SECONDS_PER_TIMEFRAME[tf];
  const duration = sd.endUnix - sd.startUnix;
  const hasStub = duration % periodSeconds !== 0;
  const fullBarCount = expectedBarCount(sd, tf) - (hasStub ? 1 : 0);
  const expected: number[] = [];
  for (let i = 1; i <= fullBarCount; i++) {
    expected.push(sd.startUnix + i * periodSeconds);
  }
  if (hasStub) expected.push(sd.endUnix);
  return expected;
}

export interface RangeCompleteness {
  /** True iff no CLOSED session-day in the range is empty or incomplete. */
  ok: boolean;
  /** Session-days overlapping the range (closed + in-progress). */
  daysChecked: number;
  badDays: Array<{
    label: string;
    status: "empty" | "incomplete";
    missing: number;
    extra: number;
  }>;
  /** Days still open (endUnix > nowUnix) — not validatable; callers must
   *  surface them. */
  inProgressDays: string[];
}

/** A mismatched day with zero cached bars is "empty"; anything else is
 *  "incomplete"/"partial". Single home so consumers can't drift. */
export function mismatchIsEmpty(r: Pick<ValidationResult, "actual">): boolean {
  return r.actual.length === 0;
}

/**
 * Range-level completeness: every closed session-day overlapping
 * [startUnix, endUnix] must structurally validate at `timeframe`. The
 * preflight primitive for consumers that read the cache directly.
 *
 * Stamp-level per day, no COUNT shortcut: a count match with offsetting
 * missing+extra stamps (orphan rows) must be reported here — the backtest
 * walker reads the cache directly and this is its only gate.
 */
export function validateRangeComplete(
  db: Database,
  symbol: string,
  timeframe: Exclude<Timeframe, "1d">,
  startUnix: number,
  endUnix: number,
  template: SessionTemplate,
  nowUnix: number,
  calendar?: SessionCalendar,
): RangeCompleteness {
  const days = sessionDaysOverlapping(startUnix, endUnix, template, calendar);
  const badDays: RangeCompleteness["badDays"] = [];
  const inProgressDays: string[] = [];

  for (const day of days) {
    if (day.endUnix > nowUnix) {
      inProgressDays.push(day.label);
      continue;
    }
    const r = validateSessionDay(db, symbol, day, timeframe, nowUnix);
    if (r.status !== "mismatch") continue;
    badDays.push({
      label: day.label,
      status: mismatchIsEmpty(r) ? "empty" : "incomplete",
      missing: r.missing.length,
      extra: r.extra.length,
    });
  }

  return {
    ok: badDays.length === 0,
    daysChecked: days.length,
    badDays,
    inProgressDays,
  };
}

/** Shared refusal copy for incomplete ranges. */
export function describeBadDays(
  badDays: RangeCompleteness["badDays"],
  timeframe: string,
): string {
  const head = badDays
    .slice(0, 5)
    .map(
      (d) =>
        `${d.label} (${d.status}${d.status === "incomplete" ? `, ${d.missing} missing` : ""})`,
    )
    .join(", ");
  const more = badDays.length > 5 ? ` …and ${badDays.length - 5} more` : "";
  return `${badDays.length} session-day(s) incomplete at ${timeframe}: ${head}${more}`;
}

export type ValidationStatus = "ok" | "mismatch" | "skipped";

export interface ValidationResult {
  sessionDay: string; // session-day label, e.g. "2026-05-01"
  symbol: string;
  timeframe: Timeframe;
  expected: number[];
  actual: number[];
  missing: number[];
  extra: number[];
  status: ValidationStatus;
  skipReason?: string;
}

/**
 * Structural validation of cached bars for one (session-day, timeframe).
 * Compares the bars actually in the DB against what the session-day
 * geometry says should be there. Does NOT check OHLCV values.
 *
 * Skip rule: in-progress session-days (endUnix > nowUnix) return
 * "skipped". Everything else is either "ok" or "mismatch".
 *
 * Expected close-stamps are computed generically from session geometry:
 *
 *   periodSeconds = period(timeframe)
 *   duration      = endUnix - startUnix
 *   fullBars      = floor(duration / periodSeconds)
 *   hasStub       = duration % periodSeconds !== 0
 *   expected      = [startUnix + i*periodSeconds for i in 1..fullBars]
 *   if hasStub:     expected.push(endUnix)
 *
 * For CME ETH (23h sessions): 15m/30m/1h have no stub (period evenly
 * divides 82800s); 2h has a 1h stub at the session close; 4h has a 3h
 * stub at the session close. The formula is invariant across seasons
 * because unix seconds are TZ-agnostic — DST shifts only the wall-clock
 * label, not the duration.
 *
 * SessionTemplate is intentionally not a parameter: the caller has
 * already used the template to construct the SessionDay, and the
 * validator only needs the resolved unix-second window.
 */
export function validateSessionDay(
  db: Database,
  symbol: string,
  sessionDay: SessionDay,
  timeframe: Timeframe,
  nowUnix: number,
): ValidationResult {
  const base = {
    sessionDay: sessionDay.label,
    symbol,
    timeframe,
  };

  if (timeframe === "1d") {
    throw new Error(
      `validateSessionDay: timeframe "1d" is not stored in the intraday cache. Daily candles are sourced on demand by the SMA rollup layer.`,
    );
  }

  if (sessionDay.endUnix > nowUnix) {
    return {
      ...base,
      expected: [],
      actual: [],
      missing: [],
      extra: [],
      status: "skipped",
      skipReason: "in-progress",
    };
  }

  const expected = expectedCloseStamps(sessionDay, timeframe);

  // Half-open session window: (startUnix, endUnix]. Matches D.2 / D.6
  // convention used throughout the codebase.
  const rows = db
    .prepare(
      `SELECT timestamp FROM candles
         WHERE symbol = ? AND timeframe = ?
           AND timestamp > ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
    )
    .all(symbol, timeframe, sessionDay.startUnix, sessionDay.endUnix) as Array<{
    timestamp: number;
  }>;

  const actual = rows.map((r) => r.timestamp);

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((t) => !actualSet.has(t));
  const extra = actual.filter((t) => !expectedSet.has(t));

  const status: ValidationStatus =
    missing.length === 0 && extra.length === 0 ? "ok" : "mismatch";

  return {
    ...base,
    expected,
    actual,
    missing,
    extra,
    status,
  };
}
