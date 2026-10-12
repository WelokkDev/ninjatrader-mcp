import type { Database } from "better-sqlite3";
import type { SessionDay, SessionTemplate } from "../sessions/types.js";
import type { Timeframe } from "../types.js";
import { REGISTRY } from "../sessions/registry.js";

// Intraday period lengths. "1d" has no fixed period — its geometry is the
// session-day itself (see DAILY_* below), so it is absent by design and every
// lookup here is guarded by an isDaily() check first.
const SECONDS_PER_TIMEFRAME: Record<Exclude<Timeframe, "1d">, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
};

/**
 * Daily geometry: exactly ONE bar per session-day, close-stamped at the
 * session's end — the same convention every other TF uses for its final bar.
 *
 * This is the cache's canonical stamp, not necessarily the stamp NT8 hands
 * over: the ingest path re-stamps incoming daily bars onto their session-day's
 * `endUnix` (see normalizeDailyStamps in bridge/ingest.ts) so that every
 * validator, purge and query below stays pure session geometry.
 */
function isDaily(tf: Timeframe): tf is "1d" {
  return tf === "1d";
}

// NT8 emits a bar only for buckets with >=1 tick, so sub-minute days
// legitimately miss stamps — coarser TFs don't and have no entry here.
//
// 1s is MEASURED over 260 imported MNQ session-days (Aug 2025 - Aug 2026):
//
//                     p50     p90     p99     max
//   missingFraction  0.140   0.272   0.435   0.491
//   maxGapSeconds       13      24      38      40
//
// Prior guesses (0.8 / 900) left the gap ceiling 22x the observed max. Values
// below have headroom above these maxima — thinner instruments than MNQ will
// be sparser. 5s/15s remain estimates (15s measured at 97% of its ceiling,
// `npm run audit-bars`, 2026-08-03).
export const SPARSE_TOLERANCE: Partial<
  Record<Timeframe, { maxMissingFraction: number; maxGapSeconds: number }>
> = {
  "1s": { maxMissingFraction: 0.6, maxGapSeconds: 180 },
  "5s": { maxMissingFraction: 0.35, maxGapSeconds: 600 },
  "15s": { maxMissingFraction: 0.02, maxGapSeconds: 120 },
};

/** True iff a mismatch is acceptable zero-tick sparseness for its TF. */
export function isAcceptableSparseMismatch(
  r: Pick<ValidationResult, "timeframe" | "expected" | "missing" | "extra">,
): boolean {
  // A session-day either has its daily bar or it doesn't — nothing to be
  // tolerant about, and no period to measure a gap run against.
  if (isDaily(r.timeframe)) return false;
  const tol = SPARSE_TOLERANCE[r.timeframe];
  if (!tol || r.extra.length > 0 || r.expected.length === 0) return false;
  if (r.missing.length / r.expected.length > tol.maxMissingFraction) return false;
  const period = SECONDS_PER_TIMEFRAME[r.timeframe];
  let run = 0;
  let prev = -Infinity;
  for (const t of r.missing) {
    run = t - prev === period ? run + 1 : 1;
    if (run * period > tol.maxGapSeconds) return false;
    prev = t;
  }
  return true;
}

// NT8's tick, minute and day stores drift by a fraction of a percent; a real hole is far larger.
export const THIN_VOLUME_TOLERANCE = 0.005;

// A day and its 1d bar fetched mid-session agree, so volume cannot tell it from a finished one.
const THIN_CLOSE_WINDOW_SECONDS = 900;

function isThin(symbol: string): boolean {
  return REGISTRY[symbol]?.density === "thin";
}

export function mayNeedDailyBar(symbol: string, timeframe: Timeframe): boolean {
  return !isDaily(timeframe) && isThin(symbol);
}

/** The day's own bars hold more than its 1d bar: that bar was fetched before the close. */
function overDailyBar(volume: number, daily: number): boolean {
  return volume - daily > daily * THIN_VOLUME_TOLERANCE;
}

function sessionVolume(
  db: Database,
  symbol: string,
  day: Pick<SessionDay, "startUnix" | "endUnix">,
  timeframe: Timeframe,
): number | null {
  const row = db
    .prepare(
      `SELECT SUM(volume) AS v FROM candles
        WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?`,
    )
    .get(symbol, timeframe, day.startUnix, day.endUnix) as { v: number | null };
  return row.v;
}

function volumeDefect(
  day: SessionDay,
  actual: readonly number[],
  volume: number,
  daily: number | null,
): string | undefined {
  const toClose = day.endUnix - actual[actual.length - 1];
  if (toClose >= THIN_CLOSE_WINDOW_SECONDS) {
    return `last bar is ${toClose}s before the session close`;
  }
  if (daily === null) return "no 1d bar cached to check its volume against";
  if (Math.abs(volume - daily) > daily * THIN_VOLUME_TOLERANCE) {
    return `volume ${volume} vs ${daily} on the 1d bar`;
  }
  return undefined;
}

// Named one by one so the query below can seek on (symbol, timeframe, timestamp).
const INTRADAY_TIMEFRAMES_SQL = Object.keys(SECONDS_PER_TIMEFRAME)
  .map((tf) => `'${tf}'`)
  .join(", ");

function staleDailyDefect(db: Database, symbol: string, day: SessionDay): string | undefined {
  const daily = sessionVolume(db, symbol, day, "1d");
  if (daily === null) return undefined;
  const row = db
    .prepare(
      `SELECT MAX(v) AS v FROM (
         SELECT SUM(volume) AS v FROM candles
          WHERE symbol = ? AND timeframe IN (${INTRADAY_TIMEFRAMES_SQL})
            AND timestamp > ? AND timestamp <= ?
          GROUP BY timeframe)`,
    )
    .get(symbol, day.startUnix, day.endUnix) as { v: number | null };
  if (row.v !== null && overDailyBar(row.v, daily)) {
    return `1d volume ${daily} is below the ${row.v} cached intraday — fetched before the close`;
  }
  return undefined;
}

/**
 * Expected bar count for one (session-day, timeframe) from pure session
 * geometry: full periods within (startUnix, endUnix] plus a trailing stub
 * bar when the period doesn't evenly divide the session duration. Shared
 * by validateSessionDay, the get_candles fail-closed gate, and
 * resolve_session_days' barCountEstimate so all three speak the same geometry.
 *
 * A session-day holds exactly one "1d" bar, by definition.
 */
export function expectedBarCount(
  sd: Pick<SessionDay, "startUnix" | "endUnix">,
  tf: Timeframe,
): number {
  if (isDaily(tf)) return 1;
  const period = SECONDS_PER_TIMEFRAME[tf];
  const duration = sd.endUnix - sd.startUnix;
  return Math.floor(duration / period) + (duration % period !== 0 ? 1 : 0);
}

/**
 * The close-stamps session geometry demands for one (session-day, timeframe):
 * full periods from the session start, plus a stub at the close when the
 * period doesn't divide the duration. Works off resolved unix bounds, so
 * calendar-adjusted days get their adjusted stub automatically — including
 * "1d", whose single stamp IS the (possibly early) close.
 */
export function expectedCloseStamps(
  sd: Pick<SessionDay, "startUnix" | "endUnix">,
  tf: Timeframe,
): number[] {
  if (isDaily(tf)) return [sd.endUnix];
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

/** A mismatched day with zero cached bars is "empty"; anything else is
 *  "incomplete"/"partial". Single home so consumers can't drift. */
export function mismatchIsEmpty(r: Pick<ValidationResult, "actual">): boolean {
  return r.actual.length === 0;
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
  /** Why a day read off its daily bar failed that check. */
  note?: string;
  /** The cache holds no 1d bar to verify the day against, or one fetched before the close. */
  needsDailyBar?: true;
}

/**
 * Structural validation of cached bars for one (session-day, timeframe).
 * Compares the bars actually in the DB against what the session-day
 * geometry says should be there. Does NOT check OHLCV values, except the
 * volume of a day read off its daily bar (see volumeDefect).
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
 * "1d" short-circuits the formula: its expected set is [endUnix] — the
 * session-day IS the bar. A daily row therefore validates ok/mismatch on
 * presence alone, and an early-close day expects its adjusted close stamp
 * for free (ingest re-stamps daily bars onto the resolved session end).
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

  // Sparseness is decided here so every consumer agrees without
  // re-deciding; `missing` stays populated for diagnostics.
  const shape = { timeframe, expected, missing, extra };
  let status: ValidationStatus;
  let note: string | undefined;
  let needsDailyBar = false;
  if (extra.length > 0) {
    status = "mismatch";
  } else if (missing.length === 0) {
    if (isThin(symbol) && isDaily(timeframe)) note = staleDailyDefect(db, symbol, sessionDay);
    status = note === undefined ? "ok" : "mismatch";
  } else if (!isThin(symbol) && isAcceptableSparseMismatch(shape)) {
    status = "ok";
  } else if (isThin(symbol) && actual.length > 0 && !isDaily(timeframe)) {
    const daily = sessionVolume(db, symbol, sessionDay, "1d");
    const volume = sessionVolume(db, symbol, sessionDay, timeframe) ?? 0;
    note = volumeDefect(sessionDay, actual, volume, daily);
    needsDailyBar = daily === null || overDailyBar(volume, daily);
    status = note === undefined ? "ok" : "mismatch";
  } else {
    status = "mismatch";
  }

  return {
    ...base,
    expected,
    actual,
    missing,
    extra,
    status,
    ...(note !== undefined && { note }),
    ...(needsDailyBar && { needsDailyBar: true as const }),
  };
}
