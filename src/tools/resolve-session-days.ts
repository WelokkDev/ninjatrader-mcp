import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS, SUPPORTED_TIMEFRAMES } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  SessionClosedError,
  sessionDayContaining,
  sessionDayRange,
  sessionDaysOverlapping,
} from "../core/sessions/session-day.js";
import {
  EMPTY_CALENDAR,
  loadCalendar,
  type SessionCalendar,
} from "../core/sessions/calendar.js";
import type { SessionDay, SessionTemplate } from "../core/sessions/types.js";
import type { Timeframe } from "../core/types.js";
import { expectedBarCount } from "../core/cache/validator.js";
import { formatLocalDateTime } from "../core/time.js";
import { jsonResult, textResult, type ToolResult } from "./result.js";

const RELATIVE_ANCHORS = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "last-n-sessions",
] as const;
type RelativeAnchor = (typeof RELATIVE_ANCHORS)[number];

export interface ResolveSessionDaysArgs {
  symbol: string;
  start?: string;
  end?: string;
  relative?: RelativeAnchor;
  n?: number;
}

export interface ResolveSessionDaysDeps {
  // Injectable so tests pin "today" deterministically (same pattern as AggregateOptions.now). Unix seconds.
  now?: () => number;
  // Backing store for the session calendar (holidays / early closes).
  // Without it the tool runs calendar-blind and reports holidaysModeled:false.
  db?: Database;
}

interface SessionDayOut {
  label: string;
  weekday: string;
  etSpan: string;
  startUnix: number;
  endUnix: number;
  inProgress: boolean;
}

interface RangeFlag {
  input: string;
  reason: string;
  nearest?: { prev?: string; next?: string };
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const LABEL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Pure calendar-day arithmetic on YYYY-MM-DD labels (no timezone — a
// label's calendar identity is intrinsic). Assumes a well-formed label;
// impossible dates are rejected downstream by sessionDayRange's guard.
function addDaysToLabel(label: string, days: number): string {
  const m = LABEL_RE.exec(label);
  if (!m) throw new Error(`bad session-day label: "${label}"`);
  const d = new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]) + days));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function labelWeekdayName(label: string): string {
  const m = LABEL_RE.exec(label);
  if (!m) throw new Error(`bad session-day label: "${label}"`);
  const dow = new Date(
    Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])),
  ).getUTCDay();
  return WEEKDAY_NAMES[dow];
}

// "Wed 18:00" wall-clock rendering of a unix instant in `tz`.
const SPAN_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function getSpanFmt(tz: string): Intl.DateTimeFormat {
  let fmt = SPAN_FMT_CACHE.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    SPAN_FMT_CACHE.set(tz, fmt);
  }
  return fmt;
}

function wallClock(unixSec: number, tz: string): string {
  const parts = getSpanFmt(tz).formatToParts(new Date(unixSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("weekday")} ${get("hour")}:${get("minute")}`;
}

function tzSuffix(tz: string): string {
  return tz === "America/New_York" ? "ET" : tz;
}

function formatEtSpan(startUnix: number, endUnix: number, tz: string): string {
  return `${wallClock(startUnix, tz)} → ${wallClock(endUnix, tz)} ${tzSuffix(tz)}`;
}

function isNoSpanError(err: unknown): boolean {
  return err instanceof Error && /No session span/.test(err.message);
}

function tryRange(
  label: string,
  template: SessionTemplate,
  calendar: SessionCalendar,
): { startUnix: number; endUnix: number } | null {
  try {
    return sessionDayRange(label, template, calendar);
  } catch (err) {
    // Weekends and calendar-closed holidays both mean "not a session-day".
    if (isNoSpanError(err) || err instanceof SessionClosedError) return null;
    throw err;
  }
}

// Flag copy: a holiday (with description) beats the generic weekday reason.
function nonSessionReason(label: string, calendar: SessionCalendar): string {
  const entry = calendar.get(label);
  if (entry?.kind === "closed") {
    return `market holiday${entry.description ? ` (${entry.description})` : ""}`;
  }
  return `${labelWeekdayName(label)} (no session)`;
}

// Nearest real session-days around a non-session label, formatted
// "2026-07-03 (Fri)". Bounded walk; 7 calendar days always spans a gap
// for the registered weekly templates.
function nearestSessionDays(
  label: string,
  template: SessionTemplate,
  calendar: SessionCalendar,
): { prev?: string; next?: string } {
  const nearest: { prev?: string; next?: string } = {};
  for (let k = 1; k <= 7 && nearest.prev === undefined; k++) {
    const cand = addDaysToLabel(label, -k);
    if (tryRange(cand, template, calendar)) nearest.prev = `${cand} (${labelWeekdayName(cand)})`;
  }
  for (let k = 1; k <= 7 && nearest.next === undefined; k++) {
    const cand = addDaysToLabel(label, k);
    if (tryRange(cand, template, calendar)) nearest.next = `${cand} (${labelWeekdayName(cand)})`;
  }
  return nearest;
}

interface ResolvedEndpoint {
  day: SessionDay;
  flag?: RangeFlag;
}

// Resolve one explicit endpoint. Non-session labels (weekends) snap
// inward — start forward to the next session-day, end backward to the
// previous — and surface a flag. Impossible/malformed labels throw.
function resolveEndpoint(
  label: string,
  template: SessionTemplate,
  kind: "start" | "end",
  calendar: SessionCalendar,
): ResolvedEndpoint {
  const direct = tryRange(label, template, calendar);
  if (direct) return { day: { label, ...direct } };

  const step = kind === "start" ? 1 : -1;
  for (let k = 1; k <= 7; k++) {
    const cand = addDaysToLabel(label, step * k);
    const range = tryRange(cand, template, calendar);
    if (range) {
      return {
        day: { label: cand, ...range },
        flag: {
          input: label,
          reason: nonSessionReason(label, calendar),
          nearest: nearestSessionDays(label, template, calendar),
        },
      };
    }
  }
  throw new Error(`no session-day within 7 days of "${label}" in template "${template.name}"`);
}

// The session-day containing `now`, or — when now sits in a maintenance
// break or weekend gap — the most recent session-day that has started.
function currentOrPreviousSessionDay(
  nowUnix: number,
  template: SessionTemplate,
  calendar: SessionCalendar,
): { day: SessionDay; inGap: boolean } {
  const containing = sessionDayContaining(nowUnix, template, calendar);
  if (containing) return { day: containing, inGap: false };

  const todayLabel = formatLocalDateTime(nowUnix, template.timezone).slice(0, 10);
  for (let k = 0; k <= 7; k++) {
    const label = addDaysToLabel(todayLabel, -k);
    const range = tryRange(label, template, calendar);
    if (range && range.startUnix < nowUnix) {
      return { day: { label, ...range }, inGap: true };
    }
  }
  throw new Error(
    `no session-day within 7 days before now for template "${template.name}"`,
  );
}

function previousSessionDay(
  day: SessionDay,
  template: SessionTemplate,
  calendar: SessionCalendar,
): SessionDay {
  for (let k = 1; k <= 7; k++) {
    const label = addDaysToLabel(day.label, -k);
    const range = tryRange(label, template, calendar);
    if (range) return { label, ...range };
  }
  throw new Error(
    `no session-day within 7 days before "${day.label}" in template "${template.name}"`,
  );
}

// Monday-label of the trading week containing `label`.
function mondayOfWeek(label: string): string {
  const m = LABEL_RE.exec(label);
  if (!m) throw new Error(`bad session-day label: "${label}"`);
  const dow = new Date(
    Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])),
  ).getUTCDay();
  return addDaysToLabel(label, -((dow + 6) % 7));
}

function weekSessionDays(
  mondayLabel: string,
  template: SessionTemplate,
  calendar: SessionCalendar,
): SessionDay[] {
  const days: SessionDay[] = [];
  for (let k = 0; k < 5; k++) {
    const label = addDaysToLabel(mondayLabel, k);
    const range = tryRange(label, template, calendar);
    if (range) days.push({ label, ...range });
  }
  return days;
}

export function createResolveSessionDaysHandler(deps: ResolveSessionDaysDeps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return async ({
    symbol,
    start,
    end,
    relative,
    n,
  }: ResolveSessionDaysArgs): Promise<ToolResult> => {
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return textResult(
        `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
      );
    }

    const hasExplicit = start !== undefined || end !== undefined;
    const hasRelative = relative !== undefined;
    if (hasExplicit === hasRelative) {
      return textResult(
        "Provide either an explicit range (start + end, YYYY-MM-DD) or a relative anchor — exactly one of the two.",
      );
    }
    if (hasExplicit && (start === undefined || end === undefined)) {
      return textResult(
        "Provide either start + end together (YYYY-MM-DD) — an explicit range needs both.",
      );
    }
    if (relative === "last-n-sessions" && (n === undefined || !Number.isInteger(n) || n < 1)) {
      return textResult('relative "last-n-sessions" requires `n` — a positive integer session count.');
    }

    const config = getInstrumentConfig(symbol);
    const template = config.session;
    const tz = template.timezone;
    const nowUnix = now();
    const calendar = deps.db ? loadCalendar(deps.db, template.name) : EMPTY_CALENDAR;

    const todayLabel = formatLocalDateTime(nowUnix, tz).slice(0, 10);
    const today = {
      label: todayLabel,
      weekday: labelWeekdayName(todayLabel),
      et: `${formatLocalDateTime(nowUnix, tz)} ${tzSuffix(tz)}`,
    };

    const flags: RangeFlag[] = [];
    let days: SessionDay[];
    let requested: Record<string, unknown>;

    try {
      if (hasExplicit) {
        requested = { mode: "explicit", start, end };
        const startEp = resolveEndpoint(start!, template, "start", calendar);
        const endEp = resolveEndpoint(end!, template, "end", calendar);
        if (startEp.flag) flags.push(startEp.flag);
        if (endEp.flag && endEp.flag.input !== startEp.flag?.input) flags.push(endEp.flag);

        if (!startEp.flag && !endEp.flag && startEp.day.startUnix >= endEp.day.endUnix) {
          return textResult(
            `start session-day ${start} is not before end session-day ${end}`,
          );
        }
        days = sessionDaysOverlapping(startEp.day.startUnix, endEp.day.endUnix, template, calendar);
      } else {
        const anchor = currentOrPreviousSessionDay(nowUnix, template, calendar);
        if (anchor.inGap) {
          flags.push({
            input: todayLabel,
            reason: `now is in a session gap (weekend or maintenance break); anchored to most recent session-day ${anchor.day.label}`,
          });
        }
        requested = {
          mode: "relative",
          relative,
          ...(relative === "last-n-sessions" && { n }),
          anchor: anchor.day.label,
        };

        switch (relative!) {
          case "today":
            days = [anchor.day];
            break;
          case "yesterday":
            days = [previousSessionDay(anchor.day, template, calendar)];
            break;
          case "last-n-sessions": {
            days = [anchor.day];
            while (days.length < n!) {
              days.unshift(previousSessionDay(days[0], template, calendar));
            }
            break;
          }
          case "this-week":
            days = weekSessionDays(mondayOfWeek(anchor.day.label), template, calendar).filter(
              (d) => d.startUnix <= nowUnix,
            );
            break;
          case "last-week":
            days = weekSessionDays(
              addDaysToLabel(mondayOfWeek(anchor.day.label), -7),
              template,
              calendar,
            );
            break;
        }
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return textResult(`Could not resolve session-days for ${symbol}: ${m}`);
    }

    // Surface calendar-closed dates inside the resolved window as flags —
    // they are absent from `days` and that absence must be explained.
    if (calendar.size > 0) {
      const lo = hasExplicit ? start! : days.length > 0 ? days[0].label : undefined;
      const hi = hasExplicit ? end! : days.length > 0 ? days[days.length - 1].label : undefined;
      if (lo !== undefined && hi !== undefined) {
        for (const [date, entry] of calendar) {
          if (
            entry.kind === "closed" &&
            date >= lo &&
            date <= hi &&
            !flags.some((f) => f.input === date)
          ) {
            flags.push({
              input: date,
              reason: nonSessionReason(date, calendar),
              nearest: nearestSessionDays(date, template, calendar),
            });
          }
        }
      }
    }

    const sessionDays: SessionDayOut[] = days.map((d) => ({
      label: d.label,
      weekday: labelWeekdayName(d.label),
      etSpan: formatEtSpan(d.startUnix, d.endUnix, tz),
      startUnix: d.startUnix,
      endUnix: d.endUnix,
      inProgress: d.endUnix > nowUnix,
    }));

    const barCountEstimate = Object.fromEntries(
      SUPPORTED_TIMEFRAMES.map((tf) => [
        tf,
        days.reduce(
          (acc, d) => acc + expectedBarCount(d, tf as Exclude<Timeframe, "1d">),
          0,
        ),
      ]),
    );

    return jsonResult({
      today,
      requested,
      sessionDays,
      flags,
      // False = calendar-blind for this template: holidays may
      // appear as normal session-days.
      holidaysModeled: calendar.size > 0,
      barCountEstimate,
    });
  };
}

export function registerResolveSessionDays(server: McpServer): void {
  const handler = createResolveSessionDaysHandler({ db: defaultDb });

  server.tool(
    "resolve_session_days",
    "Resolve date intent into exact session-days for an instrument — pure calendar math, zero data fetching, free to call anytime. The server's wall clock is authoritative: use this instead of doing relative-date arithmetic yourself. Returns the server's `today`, the resolved session-days (label, weekday, ET span, startUnix/endUnix — feed the YYYY-MM-DD labels into start_experiment's startDay/endDay), flags for weekend/non-session inputs with the nearest real session-days, and per-timeframe expected bar counts (use these to size get_candles `limit` and avoid its over-limit refusal). Exchange holidays are NOT modeled (`holidaysModeled: false`) — a holiday can look like a normal session-day; verify against the exchange calendar for holiday weeks. Convention: for a bounded/specific date range (backtest windows, batch pulls, exact dates), resolve here and confirm the labels + ET spans with the operator BEFORE fetching. For exploratory reads, prefer over-fetching (pad the range) over precision.",
    {
      symbol: z
        .string()
        .describe("Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC) — picks the session template."),
      start: z
        .string()
        .optional()
        .describe(
          "Explicit range start session-day (YYYY-MM-DD, close-date convention). Use together with `end`; mutually exclusive with `relative`.",
        ),
      end: z
        .string()
        .optional()
        .describe("Explicit range end session-day (YYYY-MM-DD), inclusive."),
      relative: z
        .enum(RELATIVE_ANCHORS)
        .optional()
        .describe(
          "Relative anchor resolved server-side against the real wall clock. Mutually exclusive with start/end.",
        ),
      n: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Session count — required when relative is "last-n-sessions".'),
    },
    handler,
  );
}
