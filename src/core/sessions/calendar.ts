import type { Database } from "better-sqlite3";
import { BOOTSTRAP_CALENDARS } from "./calendars/bootstrap.js";

// Session-calendar access layer over the session_calendar table.
//
// NT8 declares WHICH dates are exceptions; the TIME of an early close is
// only ever recorded from a real fetch of a DECLARED date. Undeclared
// short days stay loud validation mismatches — never auto-blessed.
// No module cache: loadCalendar is one idempotent bootstrap pass plus one
// indexed SELECT; caching would add a stale-calendar bug class.

export type CalendarSource = "bootstrap" | "nt8" | "nt8-observed" | "manual";

export interface CalendarEntry {
  date: string; // session-day label YYYY-MM-DD
  kind: "closed" | "modified";
  closeTime?: string; // "HH:MM" wall clock in template tz
  openTime?: string;
  source: CalendarSource;
  description?: string;
}

/** Keyed by session-day label. */
export type SessionCalendar = ReadonlyMap<string, CalendarEntry>;

export const EMPTY_CALENDAR: SessionCalendar = new Map();

interface CalendarRow {
  date: string;
  kind: "closed" | "modified";
  close_time: string | null;
  open_time: string | null;
  source: CalendarSource;
  description: string | null;
}

/** Seed the bootstrap entries for `templateName` (INSERT OR IGNORE — never
 *  clobbers existing rows) and return every calendar row for the template. */
export function loadCalendar(db: Database, templateName: string): SessionCalendar {
  const bootstrap = BOOTSTRAP_CALENDARS[templateName];
  if (bootstrap && bootstrap.length > 0) {
    const seed = db.prepare(
      `INSERT OR IGNORE INTO session_calendar
         (template, date, kind, close_time, open_time, source, description)
       VALUES (?, ?, ?, ?, ?, 'bootstrap', ?)`,
    );
    const tx = db.transaction(() => {
      for (const e of bootstrap) {
        seed.run(templateName, e.date, e.kind, e.closeTime ?? null, e.openTime ?? null, e.description);
      }
    });
    tx();
  }

  const rows = db
    .prepare(
      `SELECT date, kind, close_time, open_time, source, description
         FROM session_calendar WHERE template = ?`,
    )
    .all(templateName) as CalendarRow[];

  const map = new Map<string, CalendarEntry>();
  for (const r of rows) {
    map.set(r.date, {
      date: r.date,
      kind: r.kind,
      ...(r.close_time !== null && { closeTime: r.close_time }),
      ...(r.open_time !== null && { openTime: r.open_time }),
      source: r.source,
      ...(r.description !== null && { description: r.description }),
    });
  }
  return map;
}

/**
 * Record an observed early close. Writes only when the row exists, is
 * `modified`, carries no time yet, and is not `manual` — undeclared dates
 * never receive times; operator overrides are never touched. Returns true
 * iff a row was updated.
 */
export function recordObservedClose(
  db: Database,
  templateName: string,
  date: string,
  closeTime: string,
): boolean {
  const res = db
    .prepare(
      `UPDATE session_calendar
          SET close_time = ?, source = 'nt8-observed'
        WHERE template = ? AND date = ?
          AND kind = 'modified'
          AND close_time IS NULL
          AND source != 'manual'`,
    )
    .run(closeTime, templateName, date);
  return res.changes === 1;
}

/**
 * Upsert a synced NT8 declaration. New dates insert as source 'nt8';
 * existing rows update kind/description only — times, source, and
 * 'manual' rows are preserved.
 */
export function upsertFromSync(
  db: Database,
  templateName: string,
  e: { date: string; kind: "closed" | "modified"; description?: string },
): void {
  db.prepare(
    `INSERT INTO session_calendar (template, date, kind, source, description)
     VALUES (?, ?, ?, 'nt8', ?)
     ON CONFLICT (template, date) DO UPDATE
       SET kind = excluded.kind,
           description = excluded.description
     WHERE session_calendar.source != 'manual'`,
  ).run(templateName, e.date, e.kind, e.description ?? null);
}
