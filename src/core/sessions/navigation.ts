import type { SessionDay, SessionTemplate, Weekday } from "./types.js";
import type { SessionCalendar } from "./calendar.js";
import {
  NoSessionSpanError,
  SessionClosedError,
  sessionDayContaining,
  sessionDayRange,
} from "./session-day.js";
import { tzParts } from "../time.js";

// Pure session-calendar navigation on (template, calendar): label
// arithmetic and previous/current/anchored session-day queries.
// Presentation (flag copy, formatted spans) stays in the tool layer.

/** Short weekday names indexed by Weekday (Sun=0..Sat=6). */
export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const LABEL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseLabel(label: string): { y: number; m: number; d: number } {
  const m = LABEL_RE.exec(label);
  if (!m) throw new Error(`bad session-day label: "${label}"`);
  return { y: parseInt(m[1]), m: parseInt(m[2]), d: parseInt(m[3]) };
}

// Pure calendar-day arithmetic on YYYY-MM-DD labels (no timezone — a
// label's calendar identity is intrinsic). Assumes a well-formed label;
// impossible dates are rejected downstream by sessionDayRange's guard.
export function addDaysToLabel(label: string, days: number): string {
  const p = parseLabel(label);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Weekday of a label's calendar date (timezone-independent). */
export function labelWeekday(label: string): Weekday {
  const p = parseLabel(label);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() as Weekday;
}

export function labelWeekdayName(label: string): string {
  return WEEKDAY_NAMES[labelWeekday(label)];
}

// Monday-label of the trading week containing `label`.
export function mondayOfWeek(label: string): string {
  return addDaysToLabel(label, -((labelWeekday(label) + 6) % 7));
}

// sessionDayRange with the expected "not a session-day" outcomes
// (weekend, calendar-closed holiday) mapped to null; data-integrity
// errors still throw.
export function trySessionDayRange(
  label: string,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): { startUnix: number; endUnix: number } | null {
  try {
    return sessionDayRange(label, template, calendar);
  } catch (err) {
    if (err instanceof NoSessionSpanError || err instanceof SessionClosedError) {
      return null;
    }
    throw err;
  }
}

// Nearest real session-days around a non-session label, as bare labels.
// Bounded walk; 7 calendar days always spans a gap for the registered
// weekly templates.
export function nearestSessionDays(
  label: string,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): { prev?: string; next?: string } {
  const nearest: { prev?: string; next?: string } = {};
  for (let k = 1; k <= 7 && nearest.prev === undefined; k++) {
    const cand = addDaysToLabel(label, -k);
    if (trySessionDayRange(cand, template, calendar)) nearest.prev = cand;
  }
  for (let k = 1; k <= 7 && nearest.next === undefined; k++) {
    const cand = addDaysToLabel(label, k);
    if (trySessionDayRange(cand, template, calendar)) nearest.next = cand;
  }
  return nearest;
}

// `label` itself when it is a session-day (snapped: false); otherwise the
// nearest session-day within 7 days in `direction` (snapped: true).
export function snapToSessionDay(
  label: string,
  template: SessionTemplate,
  direction: 1 | -1,
  calendar?: SessionCalendar,
): { day: SessionDay; snapped: boolean } {
  const direct = trySessionDayRange(label, template, calendar);
  if (direct) return { day: { label, ...direct }, snapped: false };
  for (let k = 1; k <= 7; k++) {
    const cand = addDaysToLabel(label, direction * k);
    const range = trySessionDayRange(cand, template, calendar);
    if (range) return { day: { label: cand, ...range }, snapped: true };
  }
  throw new Error(`no session-day within 7 days of "${label}" in template "${template.name}"`);
}

// The session-day containing `nowUnix`, or — when now sits in a
// maintenance break or weekend gap — the most recent session-day that has
// started (inGap: true).
export function currentOrPreviousSessionDay(
  nowUnix: number,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): { day: SessionDay; inGap: boolean } {
  const containing = sessionDayContaining(nowUnix, template, calendar);
  if (containing) return { day: containing, inGap: false };

  const p = tzParts(nowUnix, template.timezone);
  const todayLabel = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  for (let k = 0; k <= 7; k++) {
    const label = addDaysToLabel(todayLabel, -k);
    const range = trySessionDayRange(label, template, calendar);
    if (range && range.startUnix < nowUnix) {
      return { day: { label, ...range }, inGap: true };
    }
  }
  throw new Error(
    `no session-day within 7 days before now for template "${template.name}"`,
  );
}

export function previousSessionDay(
  day: SessionDay,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): SessionDay {
  for (let k = 1; k <= 7; k++) {
    const label = addDaysToLabel(day.label, -k);
    const range = trySessionDayRange(label, template, calendar);
    if (range) return { label, ...range };
  }
  throw new Error(
    `no session-day within 7 days before "${day.label}" in template "${template.name}"`,
  );
}

// Session-days of the week starting at `mondayLabel`. All 7 calendar days
// are tried — weekly templates filter to Mon-Fri, 7-day templates keep
// Sat/Sun.
export function weekSessionDays(
  mondayLabel: string,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): SessionDay[] {
  const days: SessionDay[] = [];
  for (let k = 0; k < 7; k++) {
    const label = addDaysToLabel(mondayLabel, k);
    const range = trySessionDayRange(label, template, calendar);
    if (range) days.push({ label, ...range });
  }
  return days;
}
