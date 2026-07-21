import type {
  SessionDay,
  SessionSpan,
  SessionTemplate,
  Weekday,
} from "./types.js";
import type { SessionCalendar } from "./calendar.js";
import { tzParts, wallClockToUnix } from "../time.js";

/** Thrown by sessionDayRange when the calendar declares the date fully
 *  closed (market holiday). Distinct from the "No session span" weekend
 *  error so callers can render holiday-specific guidance. */
export class SessionClosedError extends Error {
  constructor(
    readonly label: string,
    readonly description?: string,
  ) {
    super(
      `No session on ${label} — market holiday${description ? ` (${description})` : ""}`,
    );
    this.name = "SessionClosedError";
  }
}

/** Thrown by sessionDayRange when no span closes on the label's weekday
 *  (Sat/Sun for the weekly ETH templates). With SessionClosedError, one of
 *  the two expected "not a session-day" outcomes — anything else is data
 *  corruption. Message text is pinned by tests (/No session span/). */
export class NoSessionSpanError extends Error {
  constructor(
    readonly label: string,
    readonly closeWeekday: Weekday,
    readonly templateName: string,
  ) {
    super(
      `No session span with closeWeekday=${closeWeekday} for label "${label}" in template "${templateName}"`,
    );
    this.name = "NoSessionSpanError";
  }
}

interface ParsedTime {
  hour: number;
  minute: number;
  second: number;
  nextDay: boolean; // true iff the source string was "24:00" / "24:00:00"
}

function parseTime(s: string): ParsedTime {
  if (s === "24:00" || s === "24:00:00") {
    return { hour: 0, minute: 0, second: 0, nextDay: true };
  }
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error(`bad time string: "${s}"`);
  return {
    hour: parseInt(m[1]),
    minute: parseInt(m[2]),
    second: m[3] ? parseInt(m[3]) : 0,
    nextDay: false,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Add `days` to a Y/M/D triple, normalizing via Date.UTC arithmetic. Pure
// calendar-day math; no timezone involved.
function addDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

// ---------- public API ----------

// Compute (startUnix, endUnix] for the session-day labeled by `label`
// (a YYYY-MM-DD calendar date in template.timezone, representing the
// session's CLOSE date). Throws if no span has a matching closeWeekday
// for that date. With a `calendar`, declared-closed dates throw
// SessionClosedError and `modified` dates override the close/open
// wall-clock times.
export function sessionDayRange(
  label: string,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): { startUnix: number; endUnix: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`bad session-day label: "${label}"`);
  const closeY = parseInt(m[1]);
  const closeMo = parseInt(m[2]);
  const closeD = parseInt(m[3]);

  const rt = new Date(Date.UTC(closeY, closeMo - 1, closeD));
  if (
    rt.getUTCFullYear() !== closeY ||
    rt.getUTCMonth() !== closeMo - 1 ||
    rt.getUTCDate() !== closeD
  ) {
    throw new Error(`impossible calendar date: "${label}"`);
  }

  // A calendar date's weekday is timezone-independent (Weekday matches
  // Date.getUTCDay), so no Intl probe is needed.
  const closeWeekday = rt.getUTCDay() as Weekday;

  const span = findSpanByCloseWeekday(template.spans, closeWeekday);
  if (!span) {
    throw new NoSessionSpanError(label, closeWeekday, template.name);
  }

  const calEntry = calendar?.get(label);
  if (calEntry?.kind === "closed") {
    throw new SessionClosedError(label, calEntry.description);
  }
  const closeOverride =
    calEntry?.kind === "modified" && calEntry.closeTime ? calEntry.closeTime : null;
  const openOverride =
    calEntry?.kind === "modified" && calEntry.openTime ? calEntry.openTime : null;

  const closeT = parseTime(closeOverride ?? span.closeTime);
  let endUnix: number;
  if (closeT.nextDay) {
    // "24:00" — endUnix lands at 00:00:00 of the next calendar day.
    const next = addDays(closeY, closeMo, closeD, 1);
    endUnix = wallClockToUnix(next.year, next.month, next.day, 0, 0, 0, template.timezone);
  } else {
    endUnix = wallClockToUnix(
      closeY, closeMo, closeD,
      closeT.hour, closeT.minute, closeT.second,
      template.timezone,
    );
  }

  // Compute open calendar date by walking back the dayOffset (0 if
  // openWeekday == closeWeekday, else 7 - difference, etc.).
  const dayOffset = (span.closeWeekday - span.openWeekday + 7) % 7;
  const openDate = addDays(closeY, closeMo, closeD, -dayOffset);
  // A late-begin override keeps the template's open calendar date and
  // replaces only the wall-clock time.
  const openT = parseTime(openOverride ?? span.openTime);
  // Open "24:00" = midnight of the day AFTER the open calendar date —
  // expresses a late begin landing on the close date itself (e.g. a Good
  // Friday session running 00:00 → 09:15 with no prior-evening span).
  // Mirrors the "24:00" close convention above.
  const openDay = openT.nextDay
    ? addDays(openDate.year, openDate.month, openDate.day, 1)
    : openDate;
  const startUnix = openT.nextDay
    ? wallClockToUnix(openDay.year, openDay.month, openDay.day, 0, 0, 0, template.timezone)
    : wallClockToUnix(
        openDay.year, openDay.month, openDay.day,
        openT.hour, openT.minute, openT.second,
        template.timezone,
      );

  if (endUnix <= startUnix) {
    throw new Error(
      `calendar-modified session for "${label}" has close not after open (open ${openOverride ?? span.openTime}, close ${closeOverride ?? span.closeTime})`,
    );
  }

  return { startUnix, endUnix };
}

function findSpanByCloseWeekday(
  spans: readonly SessionSpan[],
  closeWeekday: Weekday,
): SessionSpan | undefined {
  for (const s of spans) {
    if (s.closeWeekday === closeWeekday) return s;
  }
  return undefined;
}

// Returns the SessionDay containing `unixSec` per the (startUnix,
// endUnix] convention. Returns null for timestamps in maintenance breaks
// (between session-day spans), weekend gaps, or within-session breaks
// declared on the template.
export function sessionDayContaining(
  unixSec: number,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): SessionDay | null {
  // A session-day's close calendar date may be the day before, of, or
  // after the input's local calendar date (most can be at most ±1, but
  // we widen to ±2 for any pathological edge case in extreme timezones).
  const inputParts = tzParts(unixSec, template.timezone);
  for (let offset = -1; offset <= 2; offset++) {
    const cand = addDays(inputParts.year, inputParts.month, inputParts.day, offset);
    const label = `${cand.year}-${pad2(cand.month)}-${pad2(cand.day)}`;
    let range: { startUnix: number; endUnix: number };
    try {
      range = sessionDayRange(label, template, calendar);
    } catch (err) {
      // Weekend (no span) or calendar-closed date — not a session-day.
      // Anything else is data corruption and must propagate loudly.
      if (err instanceof NoSessionSpanError || err instanceof SessionClosedError) {
        continue;
      }
      throw err;
    }
    if (unixSec > range.startUnix && unixSec <= range.endUnix) {
      // Within-span break check (none of the production templates use
      // these today; logic stays minimal).
      if (template.breaks && template.breaks.length > 0) {
        if (isInBreak(unixSec, template, label)) return null;
      }
      return { label, startUnix: range.startUnix, endUnix: range.endUnix };
    }
  }
  return null;
}

function isInBreak(
  unixSec: number,
  template: SessionTemplate,
  closeDateLabel: string,
): boolean {
  if (!template.breaks) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(closeDateLabel);
  if (!m) return false;
  const y = parseInt(m[1]);
  const mo = parseInt(m[2]);
  const d = parseInt(m[3]);
  // Breaks are interpreted on the close calendar date in the template's
  // timezone (matches the HKEX-lunch use case).
  for (const br of template.breaks) {
    const start = parseTime(br.startTime);
    const end = parseTime(br.endTime);
    if (start.nextDay || end.nextDay) continue; // not supported for breaks
    const startUnix = wallClockToUnix(y, mo, d, start.hour, start.minute, start.second, template.timezone);
    const endUnix = wallClockToUnix(y, mo, d, end.hour, end.minute, end.second, template.timezone);
    if (unixSec > startUnix && unixSec <= endUnix) return true;
  }
  return false;
}

export type SessionDayResolver = (unixSec: number) => SessionDay | null;

// One-entry-memo form of sessionDayContaining for per-bar loops (consecutive
// bars almost always share a session-day). Sound because session-days are
// disjoint per template+calendar; null results are never cached. Templates
// with within-session breaks are never memoized — an in-break timestamp
// satisfies the range test yet must resolve to null.
export function makeSessionDayResolver(
  template: SessionTemplate,
  calendar?: SessionCalendar,
): SessionDayResolver {
  if (template.breaks && template.breaks.length > 0) {
    return (unixSec) => sessionDayContaining(unixSec, template, calendar);
  }
  let last: SessionDay | null = null;
  return (unixSec) => {
    if (last !== null && unixSec > last.startUnix && unixSec <= last.endUnix) {
      return last;
    }
    const sd = sessionDayContaining(unixSec, template, calendar);
    if (sd !== null) last = sd;
    return sd;
  };
}

// All session-days whose (startUnix, endUnix] interval overlaps the
// query range [fromUnix, toUnix]. Used by ingest re-aggregation to
// compute the affected session-day set.
export function sessionDaysOverlapping(
  fromUnix: number,
  toUnix: number,
  template: SessionTemplate,
  calendar?: SessionCalendar,
): SessionDay[] {
  if (toUnix < fromUnix) return [];
  // Pad ±2 calendar days on each side so we catch sessions that span
  // midnight (CME ETH session opens 18:00 ET prior day).
  const fromParts = tzParts(fromUnix, template.timezone);
  const toParts = tzParts(toUnix, template.timezone);
  const startCal = addDays(fromParts.year, fromParts.month, fromParts.day, -2);
  const endCal = addDays(toParts.year, toParts.month, toParts.day, 2);

  const result: SessionDay[] = [];
  let cur = startCal;
  // Iterate calendar days inclusive.
  // Bounded iteration via a hard cap to prevent any pathological infinite loop.
  for (let i = 0; i < 366 * 5; i++) {
    const label = `${cur.year}-${pad2(cur.month)}-${pad2(cur.day)}`;
    let range: { startUnix: number; endUnix: number };
    try {
      range = sessionDayRange(label, template, calendar);
      // Overlap test: (a, b] and [c, d] overlap iff a < d && b >= c.
      if (range.startUnix < toUnix && range.endUnix >= fromUnix) {
        result.push({ label, startUnix: range.startUnix, endUnix: range.endUnix });
      }
    } catch (err) {
      // Weekend or calendar-closed date: skip. Corruption propagates.
      if (!(err instanceof NoSessionSpanError || err instanceof SessionClosedError)) {
        throw err;
      }
    }
    if (cur.year === endCal.year && cur.month === endCal.month && cur.day === endCal.day) break;
    cur = addDays(cur.year, cur.month, cur.day, 1);
  }
  // Sort by startUnix ascending (already roughly sorted via calendar-day
  // iteration, but spans crossing midnight can shuffle order slightly).
  result.sort((a, b) => a.startUnix - b.startUnix);
  return result;
}
