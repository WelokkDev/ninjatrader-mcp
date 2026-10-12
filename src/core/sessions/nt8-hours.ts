import { tzParts } from "../time.js";
import type { SessionTemplate } from "./types.js";

// Days are 0 = Sunday; times are HHMM in the template's own time zone.
export interface Nt8Session {
  beginDay: number;
  beginTime: number;
  endDay: number;
  endTime: number;
  tradingDay: number;
}

export interface Nt8Hours {
  template: string;
  timeZone: string;
  /** Standard-time offset from UTC. */
  utcOffsetMinutes: number;
  observesDst: boolean;
  sessions: Nt8Session[];
}

export function tradingHoursFields(template: SessionTemplate): {
  tradingHoursTemplate: string;
  nt8TradingHours?: string;
} {
  return {
    tradingHoursTemplate: template.name,
    ...(template.nt8TradingHours !== undefined && { nt8TradingHours: template.nt8TradingHours }),
  };
}

const DAY = 1440;
const WEEK = 7 * DAY;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Minutes into the week at UTC standard time; `close` is not wrapped, so it follows `open`.
interface TradingDay {
  open: number;
  close: number;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function standardTime(tz: string): { offsetMinutes: number; observesDst: boolean } {
  const offsetAt = (month: number): number => {
    const unix = Date.UTC(2026, month, 15, 12) / 1000;
    const p = tzParts(unix, tz);
    return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - unix) / 60;
  };
  const january = offsetAt(0);
  const july = offsetAt(6);
  // Daylight saving only ever adds to the offset.
  return { offsetMinutes: Math.min(january, july), observesDst: january !== july };
}

function minutesOfClock(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesOfHhmm(hhmm: number): number | null {
  const h = Math.floor(hhmm / 100);
  const m = hhmm % 100;
  if (!Number.isInteger(hhmm) || hhmm < 0 || h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

function serverTradingDays(template: SessionTemplate, offsetMinutes: number): Map<number, TradingDay> {
  const days = new Map<number, TradingDay>();
  for (const span of template.spans) {
    const close = span.closeWeekday * DAY + minutesOfClock(span.closeTime) - offsetMinutes;
    const length =
      mod(span.closeWeekday - span.openWeekday, 7) * DAY +
      minutesOfClock(span.closeTime) -
      minutesOfClock(span.openTime);
    days.set(span.closeWeekday, { open: close - length, close });
  }
  return days;
}

// A trading day's sessions in order, starting after the widest pause.
function joinSessions(sessions: Array<{ begin: number; length: number }>): TradingDay {
  const sorted = [...sessions].sort((a, b) => a.begin - b.begin);
  let first = 0;
  let widest = -1;
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[(i + sorted.length - 1) % sorted.length];
    const pause = mod(sorted[i].begin - (prev.begin + prev.length), WEEK);
    if (pause > widest) {
      widest = pause;
      first = i;
    }
  }
  const open = sorted[first].begin;
  let close = open;
  for (let k = 0; k < sorted.length; k++) {
    const s = sorted[(first + k) % sorted.length];
    close += mod(s.begin - close, WEEK) + s.length;
  }
  return { open, close };
}

function nt8TradingDays(nt8: Nt8Hours): Map<number, TradingDay> | string {
  const byDay = new Map<number, Array<{ begin: number; length: number }>>();
  for (const s of nt8.sessions) {
    const begin = minutesOfHhmm(s.beginTime);
    const end = minutesOfHhmm(s.endTime);
    const days = [s.beginDay, s.endDay, s.tradingDay];
    if (begin === null || end === null || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return `NT8 session row unreadable: ${JSON.stringify(s)}`;
    }
    const beginAt = s.beginDay * DAY + begin;
    const length = mod(s.endDay * DAY + end - beginAt, WEEK) || WEEK;
    const list = byDay.get(s.tradingDay) ?? [];
    list.push({ begin: mod(beginAt - nt8.utcOffsetMinutes, WEEK), length });
    byDay.set(s.tradingDay, list);
  }
  const days = new Map<number, TradingDay>();
  for (const [day, sessions] of byDay) days.set(day, joinSessions(sessions));
  return days;
}

/** Compares each session-day's open and close only, not the pauses inside a day. */
export function compareWithNt8Hours(template: SessionTemplate, nt8: Nt8Hours): string[] {
  const ours = standardTime(template.timezone);
  const theirDays = nt8TradingDays(nt8);
  if (typeof theirDays === "string") return [theirDays];
  const ourDays = serverTradingDays(template, ours.offsetMinutes);

  const at = (minute: number): string => {
    const local = mod(minute + ours.offsetMinutes, WEEK);
    return `${DAY_NAMES[Math.floor(local / DAY)]} ${pad2(Math.floor((local % DAY) / 60))}:${pad2(local % 60)}`;
  };

  const differences: string[] = [];
  if (ours.observesDst !== nt8.observesDst) {
    differences.push(
      `NT8 keeps these hours in ${nt8.timeZone}, which ${nt8.observesDst ? "observes" : "has no"} ` +
        `daylight saving, unlike ${template.timezone}; compared at standard time`,
    );
  }
  for (let day = 0; day < 7; day++) {
    const a = ourDays.get(day);
    const b = theirDays.get(day);
    const name = DAY_NAMES[day];
    if (a && !b) {
      differences.push(`${name}: NT8 has no session-day (here ${at(a.open)} → ${at(a.close)})`);
    } else if (b && !a) {
      differences.push(`${name}: NT8 has a session-day the server lacks (${at(b.open)} → ${at(b.close)})`);
    } else if (a && b) {
      if (mod(a.open - b.open, WEEK) !== 0) {
        differences.push(`${name} opens ${at(b.open)} in NT8, ${at(a.open)} here`);
      }
      if (mod(a.close - b.close, WEEK) !== 0) {
        differences.push(`${name} closes ${at(b.close)} in NT8, ${at(a.close)} here`);
      }
    }
  }
  return differences;
}

export function describeNt8Sessions(nt8: Nt8Hours): string {
  const clock = (hhmm: number): string => `${pad2(Math.floor(hhmm / 100))}:${pad2(hhmm % 100)}`;
  const rows = nt8.sessions.map(
    (s) =>
      `${DAY_NAMES[s.beginDay] ?? s.beginDay} ${clock(s.beginTime)} → ` +
      `${DAY_NAMES[s.endDay] ?? s.endDay} ${clock(s.endTime)} [${DAY_NAMES[s.tradingDay] ?? s.tradingDay}]`,
  );
  return `${rows.join(", ")} (${nt8.timeZone})`;
}
