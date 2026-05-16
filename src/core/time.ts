// Canonical timezone for the project. The NT8 AddOn converts inbound unix
// seconds to ET wall-clock before handing them to the renderer; the candle
// aggregator buckets in ET; user-facing dates ("April 30") are interpreted
// as calendar days in this zone. Keep all timestamp logic anchored here.
export const EXCHANGE_TZ = "America/New_York";

const ET_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: EXCHANGE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function etOffsetMsAt(year: number, month1: number, day: number): number {
  // Probe at 17:00 UTC, which is guaranteed to land on the same ET calendar
  // day in either EST (UTC-5) or EDT (UTC-4). Then read the ET wall-clock
  // and back out the offset.
  const probeUtcMs = Date.UTC(year, month1 - 1, day, 17, 0, 0);
  const parts = ET_PARTS_FMT.formatToParts(new Date(probeUtcMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const etAsUtcMs = Date.UTC(
    parseInt(get("year")),
    parseInt(get("month")) - 1,
    parseInt(get("day")),
    parseInt(get("hour")),
    parseInt(get("minute")),
    parseInt(get("second")),
  );
  return etAsUtcMs - probeUtcMs;
}

// Returns unix seconds for 00:00:00 in `America/New_York` on the given date.
export function etDayStart(yyyymmdd: string): number {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const offsetMs = etOffsetMsAt(y, m, d);
  return Math.floor((Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs) / 1000);
}

// Returns unix seconds for 23:59:59 in `America/New_York` on the given date.
// "End of day" convention: inclusive last second of the named ET calendar
// date. Use this for the right edge of a zone spanning "to <date>".
export function etDayEnd(yyyymmdd: string): number {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const offsetMs = etOffsetMsAt(y, m, d);
  return Math.floor((Date.UTC(y, m - 1, d, 23, 59, 59) - offsetMs) / 1000);
}

// Formats a unix-second timestamp as ET wall-clock "YYYY-MM-DD HH:MM:SS".
export function formatExchangeTime(unixSec: number): string {
  const parts = ET_PARTS_FMT.formatToParts(new Date(unixSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

// Formats a unix-second timestamp as ISO-8601 UTC.
export function formatUtc(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

// Cached Intl.DateTimeFormat instances keyed by IANA timezone. Constructing
// one is non-trivial (~tens of µs); a scan that evaluates timeOfDay across
// hundreds of zones would otherwise build the same formatter repeatedly.
const localFmtCache = new Map<string, Intl.DateTimeFormat>();

function getLocalFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = localFmtCache.get(tz);
  if (fmt) return fmt;
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
  localFmtCache.set(tz, fmt);
  return fmt;
}

// Formats a unix-second timestamp as wall-clock "YYYY-MM-DD HH:MM:SS" in
// the given IANA timezone. Mirrors formatExchangeTime but parameterized
// on tz. Throws (via Intl) if tz is not a valid IANA name — callers that
// receive tz from external config should validate via isValidTimezone
// first to surface a clean error at load time.
export function formatLocalDateTime(unixSec: number, tz: string): string {
  const parts = getLocalFormatter(tz).formatToParts(new Date(unixSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
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
