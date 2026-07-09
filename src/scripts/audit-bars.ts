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
import { RAW_TIMEFRAMES, SUPPORTED_TIMEFRAMES } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  sessionDayContaining,
  sessionDayRange,
} from "../core/sessions/session-day.js";
import { loadCalendar, type SessionCalendar } from "../core/sessions/calendar.js";
import { formatExchangeTime } from "../core/time.js";
import {
  validateSessionDay,
  type ValidationResult,
} from "../core/cache/validator.js";
import type { SessionDay } from "../core/sessions/types.js";

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
      if (RAW_TIMEFRAMES.includes(tf) && rows === 0) continue;
      if (!RAW_TIMEFRAMES.includes(tf) && !has15m && rows === 0) continue;
      const result = validateSessionDay(
        db,
        pair.symbol,
        sessionDay,
        tf,
        nowUnix,
      );
      if (result.status === "ok") ok++;
      else if (result.status === "skipped") skipped++;
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

  console.log(
    `Audit: ${ok} ok, ${mismatch} mismatch, ${skipped} skipped (in-progress)` +
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
