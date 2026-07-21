// Canonical timezone for the project. The NT8 AddOn converts inbound unix
// seconds to ET wall-clock before handing them to the renderer; the candle
// aggregator buckets in ET; user-facing dates ("April 30") are interpreted
// as calendar days in this zone. Keep all timestamp logic anchored here.
export const EXCHANGE_TZ = "America/New_York";

// ---------- shared Intl plumbing ----------

// Single formatter cache for the repo, keyed by IANA timezone —
// constructing an Intl.DateTimeFormat costs ~tens of µs. Do not grow
// per-module copies.
const PARTS_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

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

export interface TzParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Wall-clock fields of a unix instant in `tz`.
export function tzParts(unixSec: number, tz: string): TzParts {
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// UTC offset of `tz` at the instant `utcMs`, in ms. Negative west of UTC
// (ET is -5h in EST, -4h in EDT).
function offsetMsAt(utcMs: number, tz: string): number {
  const p = tzParts(Math.floor(utcMs / 1000), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

// Convert a wall-clock instant in `tz` to unix seconds via an offset
// fixpoint (third probe only near DST transitions).
//   - Nonexistent wall times (spring-forward gap): mapped forward by the
//     gap width (02:30 ET → 03:30 EDT).
//   - Ambiguous wall times (fall-back repeat): the occurrence on the
//     naive-guess side — first (pre-transition) for zones west of UTC,
//     including America/New_York.
export function wallClockToUnix(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  const wallMs = Date.UTC(year, month1 - 1, day, hour, minute, second);
  const off0 = offsetMsAt(wallMs, tz);
  const c1 = wallMs - off0;
  const off1 = offsetMsAt(c1, tz);
  if (off1 === off0) return Math.floor(c1 / 1000);
  // Near a transition: a third probe separates "exists, guess straddled
  // the transition" from "inside the spring-forward gap" (no fixpoint).
  const c2 = wallMs - off1;
  const off2 = offsetMsAt(c2, tz);
  if (off2 === off1) return Math.floor(c2 / 1000);
  // Gap: spring-forward always increases the offset, so subtracting the
  // smaller offset lands on the post-transition side — the forward mapping.
  return Math.floor((wallMs - Math.min(off0, off1)) / 1000);
}

// ---------- ET calendar-day helpers ----------

// Returns unix seconds for 00:00:00 in `America/New_York` on the given date.
export function etDayStart(yyyymmdd: string): number {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return wallClockToUnix(y, m, d, 0, 0, 0, EXCHANGE_TZ);
}

// Returns unix seconds for 23:59:59 in `America/New_York` on the given date.
// "End of day" convention: inclusive last second of the named ET calendar
// date. Use this for the right edge of a zone spanning "to <date>".
// DST transition days are 23h/25h long, so day-end minus day-start is not
// a fixed 86399 seconds on those two days a year.
export function etDayEnd(yyyymmdd: string): number {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return wallClockToUnix(y, m, d, 23, 59, 59, EXCHANGE_TZ);
}

// ---------- rendering ----------

// Formats a unix-second timestamp as ET wall-clock "YYYY-MM-DD HH:MM:SS".
export function formatExchangeTime(unixSec: number): string {
  return formatLocalDateTime(unixSec, EXCHANGE_TZ);
}

// Formats a unix-second timestamp as ISO-8601 UTC.
export function formatUtc(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

// Formats a unix-second timestamp as wall-clock "YYYY-MM-DD HH:MM:SS" in
// the given IANA timezone.
export function formatLocalDateTime(unixSec: number, tz: string): string {
  const p = tzParts(unixSec, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

export function formatLocalISO(unixSec: number, tz: string): string {
  const p = tzParts(unixSec, tz);
  // Offset = (wall-clock-as-UTC) - (actual UTC). Positive when local is
  // east of UTC, negative when west (ET is -05:00 in EST, -04:00 in EDT).
  const wallAsUtcSec = Math.floor(
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000,
  );
  const offsetMin = Math.round((wallAsUtcSec - unixSec) / 60);
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offHh = String(Math.floor(absMin / 60)).padStart(2, "0");
  const offMm = String(absMin % 60).padStart(2, "0");
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${sign}${offHh}:${offMm}`;
}

// "HH:MM" wall clock of a unix instant in `tz` (h23).
export function wallClockHHMM(unixSec: number, tz: string): string {
  const p = tzParts(unixSec, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

// Returns true if `tz` is a valid IANA timezone name. Implementation
// detail: Intl.DateTimeFormat throws RangeError on invalid timezones,
// which we swallow. Note that V8 is lenient on capitalization
// (`America/New_york` is normalized to `America/New_York` and passes)
// — only truly unknown zones get rejected.
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
