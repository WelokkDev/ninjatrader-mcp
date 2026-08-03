// Standalone DB audit. For every (symbol, session-day) pair with at
// least one cached bar, structurally validates every supported
// timeframe against the session geometry. Reports ok/mismatch/skipped
// counts and prints details for each mismatch.
//
// Discovery is rows-driven: session-days that have ZERO bars at every
// timeframe are invisible here (there's no way to enumerate "expected"
// session-days without an external calendar). Use get_candles for
// empty-range detection on demand — the tool runs the validator over
// its requested [start, end] range and surfaces empty session-days via
// the response's `validation` field.

import db from "../db/connection.js";
import {
  isRawTimeframe,
  isSubMinuteTimeframe,
  SUPPORTED_TIMEFRAMES,
} from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  sessionDayContaining,
  sessionDayRange,
} from "../core/sessions/session-day.js";
import { loadCalendar, type SessionCalendar } from "../core/sessions/calendar.js";
import { formatExchangeTime } from "../core/time.js";
import {
  SPARSE_TOLERANCE,
  validateSessionDay,
  type ValidationResult,
} from "../core/cache/validator.js";
import type { SessionDay } from "../core/sessions/types.js";
import type { Timeframe } from "../core/types.js";

function timeOnlyET(unix: number): string {
  // formatExchangeTime returns "YYYY-MM-DD HH:MM:SS". Strip to HH:MM.
  return formatExchangeTime(unix).slice(11, 16);
}

function formatStamps(stamps: number[]): string {
  if (stamps.length === 0) return "(none)";
  return stamps.map(timeOnlyET).join(", ");
}

function formatStampsWithUnix(stamps: number[]): string {
  if (stamps.length === 0) return "(none)";
  return stamps.map((t) => `${timeOnlyET(t)} (unix ${t})`).join(", ");
}

/** A day that validated ok despite missing stamps — SPARSE_TOLERANCE absorbed
 *  it. Only place this shows; used to retune the tolerance/heal floors. */
interface SparseObservation {
  symbol: string;
  label: string;
  timeframe: string;
  expected: number;
  missing: number;
  missingFraction: number;
  longestRunSecs: number;
}

function observeSparse(r: ValidationResult): SparseObservation | null {
  // Read the period off the grid itself so this works for any fixed-period TF.
  if (r.missing.length === 0 || r.expected.length < 2) return null;
  const period = r.expected[1] - r.expected[0];
  if (period <= 0) return null;
  let longest = period;
  let run = period;
  for (let i = 1; i < r.missing.length; i++) {
    run = r.missing[i] - r.missing[i - 1] === period ? run + period : period;
    if (run > longest) longest = run;
  }
  return {
    symbol: r.symbol,
    label: r.sessionDay,
    timeframe: r.timeframe,
    expected: r.expected.length,
    missing: r.missing.length,
    missingFraction: r.missing.length / r.expected.length,
    longestRunSecs: longest,
  };
}

function main(): void {
  const nowUnix = Math.floor(Date.now() / 1000);

  // Discover all (symbol, session-day) pairs with at least one bar at
  // any TF. A session-day with zero bars at every TF is invisible
  // here — by design (see header comment).
  const distinctRows = db
    .prepare(`SELECT DISTINCT symbol, timestamp FROM candles`)
    .all() as Array<{ symbol: string; timestamp: number }>;

  // Session calendars per template (holiday / early-close exceptions).
  const calendars = new Map<string, SessionCalendar>();
  const calendarFor = (templateName: string): SessionCalendar => {
    let cal = calendars.get(templateName);
    if (!cal) {
      cal = loadCalendar(db, templateName);
      calendars.set(templateName, cal);
    }
    return cal;
  };

  const pairs = new Map<string, { symbol: string; label: string }>();
  let orphanClosedDayBars = 0;
  for (const row of distinctRows) {
    let config;
    try {
      config = getInstrumentConfig(row.symbol);
    } catch {
      continue; // unknown symbol in the DB — skip
    }
    const sd = sessionDayContaining(row.timestamp, config.session, calendarFor(config.session.name));
    if (sd === null) {
      // Bars on closed holidays or after an early close map to no
      // session-day — count them as orphans rather than skip silently.
      orphanClosedDayBars++;
      continue;
    }
    pairs.set(`${row.symbol}|${sd.label}`, {
      symbol: row.symbol,
      label: sd.label,
    });
  }

  const sortedPairs = [...pairs.values()].sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) || a.label.localeCompare(b.label),
  );

  let ok = 0;
  let mismatch = 0;
  let skipped = 0;
  const issues: ValidationResult[] = [];
  const sparse: SparseObservation[] = [];

  const countStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM candles
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?`,
  );

  for (const pair of sortedPairs) {
    const config = getInstrumentConfig(pair.symbol);
    const range = sessionDayRange(pair.label, config.session, calendarFor(config.session.name));
    const sessionDay: SessionDay = {
      label: pair.label,
      startUnix: range.startUnix,
      endUnix: range.endUnix,
    };
    const rowsAt = (tf: string): number =>
      (countStmt.get(pair.symbol, tf, range.startUnix, range.endUnix) as { c: number }).c;
    const has15m = rowsAt("15m") > 0;
    for (const tf of SUPPORTED_TIMEFRAMES) {
      // Raw streams are opt-in: never-ingested is not a finding. Derived
      // TFs are expected whenever their 15m source exists, and still
      // checked when they hold orphan rows without one.
      const rows = rowsAt(tf);
      if (isRawTimeframe(tf) && rows === 0) continue;
      if (!isRawTimeframe(tf) && !has15m && rows === 0) continue;
      const result = validateSessionDay(
        db,
        pair.symbol,
        sessionDay,
        tf,
        nowUnix,
      );
      if (result.status === "ok") {
        ok++;
        // "ok" with missing stamps means SPARSE_TOLERANCE absorbed the day.
        if (isSubMinuteTimeframe(tf)) {
          const obs = observeSparse(result);
          if (obs) sparse.push(obs);
        }
      } else if (result.status === "skipped") skipped++;
      else {
        mismatch++;
        issues.push(result);
      }
    }
  }

  for (const issue of issues) {
    console.log(
      `MISMATCH ${issue.symbol} ${issue.sessionDay} ${issue.timeframe}`,
    );
    // For dense timeframes (5m/15m) the expected/actual lines get long.
    // Cap to first/last to keep output scannable; the missing/extra
    // lines tell the full story anyway.
    const cap = 12;
    if (issue.expected.length <= cap) {
      console.log(`  expected: ${formatStamps(issue.expected)} ET`);
    } else {
      const head = issue.expected.slice(0, 3).map(timeOnlyET).join(", ");
      const tail = issue.expected.slice(-3).map(timeOnlyET).join(", ");
      console.log(
        `  expected: ${head}, … (${issue.expected.length} total), ${tail} ET`,
      );
    }
    if (issue.actual.length <= cap) {
      console.log(`  actual:   ${formatStamps(issue.actual)} ET`);
    } else {
      const head = issue.actual.slice(0, 3).map(timeOnlyET).join(", ");
      const tail = issue.actual.slice(-3).map(timeOnlyET).join(", ");
      console.log(
        `  actual:   ${head}, … (${issue.actual.length} total), ${tail} ET`,
      );
    }
    console.log(`  missing:  ${formatStampsWithUnix(issue.missing)}`);
    console.log(`  extra:    ${formatStampsWithUnix(issue.extra)}`);
    console.log();
  }

  if (sparse.length > 0) {
    console.log("SPARSE (validated ok, absorbed by SPARSE_TOLERANCE)");
    console.log(
      "  These are the observations to retune validator.ts SPARSE_TOLERANCE",
    );
    console.log("  and live/heal.ts GAP_MIN_SPAN_SECS from.");
    console.log();
    const byTf = new Map<string, SparseObservation[]>();
    for (const o of sparse) {
      const list = byTf.get(o.timeframe);
      if (list) list.push(o);
      else byTf.set(o.timeframe, [o]);
    }
    for (const [tf, obs] of [...byTf.entries()].sort()) {
      const tol = SPARSE_TOLERANCE[tf as Timeframe];
      const worstFrac = obs.reduce((a, o) => Math.max(a, o.missingFraction), 0);
      const worstRun = obs.reduce((a, o) => Math.max(a, o.longestRunSecs), 0);
      const meanFrac = obs.reduce((a, o) => a + o.missingFraction, 0) / obs.length;
      console.log(
        `  ${tf}: ${obs.length} day(s)` +
          `  missingFraction mean ${meanFrac.toFixed(4)} / worst ${worstFrac.toFixed(4)}` +
          (tol ? ` (tolerance ${tol.maxMissingFraction})` : "") +
          `  longest run ${worstRun}s` +
          (tol ? ` (tolerance ${tol.maxGapSeconds}s)` : ""),
      );
      // The single worst day per TF, so a retune has a concrete date to pull.
      const worstDay = obs.reduce((a, o) => (o.longestRunSecs > a.longestRunSecs ? o : a));
      console.log(
        `      worst run: ${worstDay.symbol} ${worstDay.label} — ${worstDay.longestRunSecs}s ` +
          `(${worstDay.missing}/${worstDay.expected} stamps absent)`,
      );
    }
    console.log();
  }

  console.log(
    `Audit: ${ok} ok, ${mismatch} mismatch, ${skipped} skipped (in-progress)` +
      (sparse.length > 0 ? `, ${sparse.length} sparse-tolerated` : "") +
      (orphanClosedDayBars > 0
        ? `, ${orphanClosedDayBars} orphan timestamp(s) outside any session-day`
        : ""),
  );
  if (mismatch > 0) {
    console.log();
    console.log(
      "NOTE: The session calendar models holidays/early closes — a mismatch",
    );
    console.log(
      "      is a REAL finding. Declared-untimed early closes heal on the",
    );
    console.log(
      "      next get_candles/prefetch of that day (observed-close interlock).",
    );
    console.log("      Audit only covers session-days that have ≥1 cached bar.");
  }
  process.exit(mismatch > 0 ? 1 : 0);
}

main();
