import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS, SUPPORTED_TIMEFRAMES } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDaysOverlapping } from "../core/sessions/session-day.js";
import {
  WEEKDAY_NAMES,
  addDaysToLabel,
  currentOrPreviousSessionDay,
  labelWeekdayName,
  mondayOfWeek,
  nearestSessionDays,
  previousSessionDay,
  snapToSessionDay,
  weekSessionDays,
} from "../core/sessions/navigation.js";
import {
  EMPTY_CALENDAR,
  loadCalendar,
  type SessionCalendar,
} from "../core/sessions/calendar.js";
import type { SessionDay, SessionTemplate } from "../core/sessions/types.js";
import type { Timeframe } from "../core/types.js";
import { expectedBarCount } from "../core/cache/validator.js";
import { formatLocalDateTime, tzParts } from "../core/time.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

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

// ---------- presentation helpers (core math lives in sessions/navigation) ----------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// "Wed 18:00" wall-clock rendering of a unix instant in `tz` (weekday is
// that of the tz-local calendar date).
function wallClock(unixSec: number, tz: string): string {
  const p = tzParts(unixSec, tz);
  const wd = WEEKDAY_NAMES[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  return `${wd} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

function tzSuffix(tz: string): string {
  return tz === "America/New_York" ? "ET" : tz;
}

function formatEtSpan(startUnix: number, endUnix: number, tz: string): string {
  return `${wallClock(startUnix, tz)} → ${wallClock(endUnix, tz)} ${tzSuffix(tz)}`;
}

// Flag copy: a holiday (with description) beats the generic weekday reason.
function nonSessionReason(label: string, calendar: SessionCalendar): string {
  const entry = calendar.get(label);
  if (entry?.kind === "closed") {
    return `market holiday${entry.description ? ` (${entry.description})` : ""}`;
  }
  return `${labelWeekdayName(label)} (no session)`;
}

// "2026-07-03 (Fri)" presentation of bare nearest-session labels.
function fmtNearest(n: { prev?: string; next?: string }): { prev?: string; next?: string } {
  const out: { prev?: string; next?: string } = {};
  if (n.prev !== undefined) out.prev = `${n.prev} (${labelWeekdayName(n.prev)})`;
  if (n.next !== undefined) out.next = `${n.next} (${labelWeekdayName(n.next)})`;
  return out;
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
  const res = snapToSessionDay(label, template, kind === "start" ? 1 : -1, calendar);
  if (!res.snapped) return { day: res.day };
  return {
    day: res.day,
    flag: {
      input: label,
      reason: nonSessionReason(label, calendar),
      nearest: fmtNearest(nearestSessionDays(label, template, calendar)),
    },
  };
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
      return errorResult(
        `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
      );
    }

    const hasExplicit = start !== undefined || end !== undefined;
    const hasRelative = relative !== undefined;
    if (hasExplicit === hasRelative) {
      return errorResult(
        "Provide either an explicit range (start + end, YYYY-MM-DD) or a relative anchor — exactly one of the two.",
      );
    }
    if (hasExplicit && (start === undefined || end === undefined)) {
      return errorResult(
        "Provide either start + end together (YYYY-MM-DD) — an explicit range needs both.",
      );
    }
    if (relative === "last-n-sessions" && (n === undefined || !Number.isInteger(n) || n < 1)) {
      return errorResult('relative "last-n-sessions" requires `n` — a positive integer session count.');
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
          return errorResult(
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
      return errorResult(`Could not resolve session-days for ${symbol}: ${m}`);
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
              nearest: fmtNearest(nearestSessionDays(date, template, calendar)),
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
        days.reduce((acc, d) => acc + expectedBarCount(d, tf), 0),
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
