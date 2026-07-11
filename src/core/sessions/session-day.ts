import type {
  SessionDay,
  SessionSpan,
  SessionTemplate,
  Weekday,
} from "./types.js";
import type { SessionCalendar } from "./calendar.js";

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

// ---------- Intl helpers (DST-safe wall-clock arithmetic) ----------

const PARTS_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function getPartsFmt(tz: string): Intl.DateTimeFormat {
  let fmt = PARTS_FMT_CACHE.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    PARTS_FMT_CACHE.set(tz, fmt);
  }
  return fmt;
}

function getWeekdayFmt(tz: string): Intl.DateTimeFormat {
  let fmt = WEEKDAY_FMT_CACHE.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
    });
    WEEKDAY_FMT_CACHE.set(tz, fmt);
  }
  return fmt;
}

const WEEKDAY_NAME_TO_INDEX: Record<string, Weekday> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface TzParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getTzParts(unixSec: number, tz: string): TzParts {
  const parts = getPartsFmt(tz).formatToParts(new Date(unixSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    year: parseInt(get("year")),
    month: parseInt(get("month")),
    day: parseInt(get("day")),
    hour: parseInt(get("hour")),
    minute: parseInt(get("minute")),
    second: parseInt(get("second")),
  };
}

function getWeekdayInTz(unixSec: number, tz: string): Weekday {
  const name = getWeekdayFmt(tz).format(new Date(unixSec * 1000));
  const w = WEEKDAY_NAME_TO_INDEX[name];
  if (w === undefined) throw new Error(`unrecognized weekday: ${name}`);
  return w;
}

// Convert a wall-clock instant in `tz` (year/month/day/hour/min/sec) to
// unix seconds. DST-safe via offset probe at noon UTC of the same date.
function tzInstantToUnix(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  // Probe at noon UTC — guaranteed to land on the same local calendar day
  // in any reasonable IANA timezone, regardless of DST.
  const probeUtcMs = Date.UTC(year, month - 1, day, 12, 0, 0);
  const parts = getTzParts(Math.floor(probeUtcMs / 1000), tz);
  const localAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offsetMs = localAsUtcMs - probeUtcMs;
  const targetMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs;
  return Math.floor(targetMs / 1000);
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

  // Determine the close-date weekday in the template's timezone. We probe
  // at noon local time on the close date to avoid any DST edge weirdness.
  const closeNoonUnix = tzInstantToUnix(closeY, closeMo, closeD, 12, 0, 0, template.timezone);
  const closeWeekday = getWeekdayInTz(closeNoonUnix, template.timezone);

  const span = findSpanByCloseWeekday(template.spans, closeWeekday);
  if (!span) {
    throw new Error(
      `No session span with closeWeekday=${closeWeekday} for label "${label}" in template "${template.name}"`,
    );
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
    endUnix = tzInstantToUnix(next.year, next.month, next.day, 0, 0, 0, template.timezone);
  } else {
    endUnix = tzInstantToUnix(
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
    ? tzInstantToUnix(openDay.year, openDay.month, openDay.day, 0, 0, 0, template.timezone)
    : tzInstantToUnix(
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
  const inputParts = getTzParts(unixSec, template.timezone);
  for (let offset = -1; offset <= 2; offset++) {
    const cand = addDays(inputParts.year, inputParts.month, inputParts.day, offset);
    const label = `${cand.year}-${pad2(cand.month)}-${pad2(cand.day)}`;
    let range: { startUnix: number; endUnix: number };
    try {
      range = sessionDayRange(label, template, calendar);
    } catch {
      // No span closes on that weekday (Sat/Sun for ETH), or the calendar
      // declares the date closed — either way, not a session-day.
      continue;
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
    const startUnix = tzInstantToUnix(y, mo, d, start.hour, start.minute, start.second, template.timezone);
    const endUnix = tzInstantToUnix(y, mo, d, end.hour, end.minute, end.second, template.timezone);
    if (unixSec > startUnix && unixSec <= endUnix) return true;
  }
  return false;
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
  const fromParts = getTzParts(fromUnix, template.timezone);
  const toParts = getTzParts(toUnix, template.timezone);
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
    } catch {
      // No span for this weekday, or calendar-closed date; skip.
    }
    if (cur.year === endCal.year && cur.month === endCal.month && cur.day === endCal.day) break;
    cur = addDays(cur.year, cur.month, cur.day, 1);
  }
  // Sort by startUnix ascending (already roughly sorted via calendar-day
  // iteration, but spans crossing midnight can shuffle order slightly).
  result.sort((a, b) => a.startUnix - b.startUnix);
  return result;
}
