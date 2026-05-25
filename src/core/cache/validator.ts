import type { Database } from "better-sqlite3";
import type { SessionDay } from "../sessions/types.js";
import type { Timeframe } from "../types.js";

// "1d" is excluded — the SQLite cache holds only intraday bars; daily bars are sourced on demand
const SECONDS_PER_TIMEFRAME: Record<Exclude<Timeframe, "1d">, number> = {
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
};

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

  const periodSeconds = SECONDS_PER_TIMEFRAME[timeframe];
  const duration = sessionDay.endUnix - sessionDay.startUnix;
  const fullBarCount = Math.floor(duration / periodSeconds);
  const hasStub = duration % periodSeconds !== 0;

  const expected: number[] = [];
  for (let i = 1; i <= fullBarCount; i++) {
    expected.push(sessionDay.startUnix + i * periodSeconds);
  }
  if (hasStub) expected.push(sessionDay.endUnix);

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
