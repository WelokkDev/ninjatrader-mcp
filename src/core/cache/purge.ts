import type { Database } from "better-sqlite3";
import type { SessionDay, SessionTemplate } from "../sessions/types.js";
import type { SessionCalendar } from "../sessions/calendar.js";
import type { Timeframe } from "../types.js";
import { sessionDayRange } from "../sessions/session-day.js";
import { expectedCloseStamps } from "./validator.js";

// Keeps IN (?, ...) deletes under SQLITE_MAX_VARIABLE_NUMBER (32766).
const DELETE_CHUNK = 5000;

/**
 * Stamps a closed session-day may hold at a raw TF: its expected close-stamp
 * grid, plus the template-anchored lattice when a calendar row overrides the
 * day's open time. That addition keeps bars cached under the old anchor from
 * being re-graded off-grid and deleted; on period-aligned shifts the two
 * lattices coincide and it is inert.
 *
 * At "1d" the grid is the single {endUnix} stamp, and the template-anchored
 * addition contributes the template close — so a daily bar cached before an
 * early close was recorded survives the reclassification like any other.
 */
export function expectedRawGrid(
  day: SessionDay,
  timeframe: Timeframe,
  session: SessionTemplate,
  calendar?: SessionCalendar,
): Set<number> {
  const expected = new Set(expectedCloseStamps(day, timeframe));
  const entry = calendar?.get(day.label);
  if (entry?.kind === "modified" && entry.openTime) {
    try {
      const templateRange = sessionDayRange(day.label, session);
      for (const t of expectedCloseStamps(templateRange, timeframe)) {
        if (t > day.startUnix && t <= day.endUnix) expected.add(t);
      }
    } catch {
      // Label unresolvable under pure template geometry — nothing to add.
    }
  }
  return expected;
}

/**
 * Delete cached raw rows at off-grid stamps within one closed session-day.
 * In-progress days are never touched. Not transactional — the caller owns
 * the transaction. Returns rows deleted.
 */
export function purgeOffGridRawRows(
  database: Database,
  symbol: string,
  timeframe: Timeframe,
  day: SessionDay,
  expected: Set<number>,
  nowUnix: number,
): number {
  if (day.endUnix > nowUnix) return 0; // in-progress: never delete
  const offGrid = (
    database
      .prepare(
        `SELECT timestamp FROM candles
          WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?`,
      )
      .all(symbol, timeframe, day.startUnix, day.endUnix) as Array<{ timestamp: number }>
  )
    .map((r) => r.timestamp)
    .filter((t) => !expected.has(t));
  for (let i = 0; i < offGrid.length; i += DELETE_CHUNK) {
    const chunk = offGrid.slice(i, i + DELETE_CHUNK);
    database
      .prepare(
        `DELETE FROM candles WHERE symbol = ? AND timeframe = ?
          AND timestamp IN (${chunk.map(() => "?").join(", ")})`,
      )
      .run(symbol, timeframe, ...chunk);
  }
  return offGrid.length;
}
