import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { REGISTRY } from "../core/sessions/registry.js";
import { recordNt8Close, upsertFromSync } from "../core/sessions/calendar.js";
import {
  compareWithNt8Hours,
  describeNt8Sessions,
  tradingHoursFields,
  type Nt8Hours,
} from "../core/sessions/nt8-hours.js";
import { sessionDayRange } from "../core/sessions/session-day.js";
import type { SessionTemplate } from "../core/sessions/types.js";
import { formatLocalDateTime, wallClockHHMM } from "../core/time.js";
import { rederiveSessionDay } from "../core/cache/fill.js";
import { request as bridgeRequest } from "./index.js";
import { isInboundType, type SessionCalendarResponseMessage } from "./protocol.js";
import { registerHelloSync, runHelloSync, type HelloSyncResult } from "./hello-sync.js";

// On every NT8 hello, sync each registered template's declared holidays and
// early-close times, and compare its hours with NT8's own. Fail-soft: never
// breaks the connection or the candle path.

export interface CalendarSyncDeps {
  db: Database;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  now?: () => number;
}

export interface Nt8HoursCheck {
  nt8Template: string;
  differences: string[];
  nt8Sessions: string;
}

export interface Nt8CalendarDifference {
  date: string;
  difference: string;
}

// A failed sync leaves a template's last verdicts standing.
const hoursChecks = new Map<string, Nt8HoursCheck>();
const calendarChecks = new Map<string, Nt8CalendarDifference[]>();

export function nt8HoursCheck(templateName: string): Nt8HoursCheck | undefined {
  return hoursChecks.get(templateName);
}

export function nt8CalendarDifferences(templateName: string): readonly Nt8CalendarDifference[] {
  return calendarChecks.get(templateName) ?? [];
}

function nt8HoursOf(res: SessionCalendarResponseMessage, nt8Template: string): Nt8Hours | null {
  if (
    res.sessions === undefined ||
    res.timeZone === undefined ||
    res.utcOffsetMinutes === undefined ||
    res.observesDst === undefined
  ) {
    return null;
  }
  return {
    template: res.template ?? nt8Template,
    timeZone: res.timeZone,
    utcOffsetMinutes: res.utcOffsetMinutes,
    observesDst: res.observesDst,
    sessions: res.sessions,
  };
}

function minuteIn(session: SessionTemplate, unix: number): string {
  return formatLocalDateTime(unix, session.timezone).slice(0, 16);
}

function applyNt8Close(
  db: Database,
  session: SessionTemplate,
  date: string,
  closeUnix: number,
  nowUnix: number,
): { applied: true } | { applied: false; difference: string } {
  const close = wallClockHHMM(closeUnix, session.timezone);
  const at = minuteIn(session, closeUnix);
  let range: { startUnix: number; endUnix: number };
  try {
    range = sessionDayRange(date, session);
  } catch {
    return { applied: false, difference: `NT8 closes it at ${at}, but it has no session-day here` };
  }
  if (!at.startsWith(date) || closeUnix <= range.startUnix || closeUnix > range.endUnix) {
    return { applied: false, difference: `NT8 closes it at ${at}, outside its session-day here` };
  }
  const outcome = recordNt8Close(db, session.name, date, close);
  if (outcome.status === "kept-manual") {
    return { applied: false, difference: `closes ${close} in NT8, ${outcome.manual} here (manual, kept)` };
  }
  if (outcome.status === "replaced") {
    console.error(
      `[calendar-sync] ${session.name} ${date}: close ${outcome.previous} (${outcome.previousSource}) replaced by NT8's ${close}`,
    );
  }
  if (outcome.status === "recorded" || outcome.status === "replaced") {
    rederiveSessionDay(db, session, date, nowUnix);
  }
  return { applied: true };
}

// NT8 writes a day nothing trades on (CME's Christmas) as a late begin at or after its close.
function opensAfterClose(session: SessionTemplate, date: string, openUnix: number): boolean {
  try {
    return openUnix >= sessionDayRange(date, session).endUnix;
  } catch {
    return false;
  }
}

export async function syncSessionCalendars(
  deps: CalendarSyncDeps,
): Promise<HelloSyncResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // Several symbols share a session template.
  const templates = new Map<string, SessionTemplate>();
  for (const config of Object.values(REGISTRY)) templates.set(config.session.name, config.session);

  return runHelloSync({
    label: "calendar-sync",
    requestType: "request_session_calendar",
    items: [...templates.keys()],
    syncOne: async (templateName) => {
      const session = templates.get(templateName)!;
      const res = await deps.request("request_session_calendar", tradingHoursFields(session));
      if (!isInboundType(res, "session_calendar_response")) {
        const t = res && typeof res === "object" ? (res as { type?: unknown }).type : res;
        throw new Error(`unexpected reply type: ${String(t)}`);
      }

      for (const h of res.holidays) {
        upsertFromSync(deps.db, templateName, {
          date: h.date,
          kind: "closed",
          description: h.description,
        });
      }
      const calendarDifferences: Nt8CalendarDifference[] = [];
      let timed = 0;
      let noSession = 0;
      let untimedLateBegins = 0;
      for (const p of res.partialHolidays) {
        const closed =
          p.isLateBegin && p.openUnix !== undefined && opensAfterClose(session, p.date, p.openUnix);
        upsertFromSync(deps.db, templateName, {
          date: p.date,
          kind: closed ? "closed" : "modified",
          description: p.description,
        });
        if (closed) {
          noSession++;
          continue;
        }
        if (p.isLateBegin) {
          untimedLateBegins++;
          if (p.openUnix !== undefined) {
            calendarDifferences.push({
              date: p.date,
              difference: `NT8 opens it late, at ${minuteIn(session, p.openUnix)}; the server keeps the usual open`,
            });
          }
        }
        if (p.closeUnix === undefined) continue;
        const close = applyNt8Close(deps.db, session, p.date, p.closeUnix, now());
        if (close.applied) timed++;
        else calendarDifferences.push({ date: p.date, difference: close.difference });
      }
      calendarChecks.set(templateName, calendarDifferences);

      const nt8 = nt8HoursOf(res, session.nt8TradingHours ?? templateName);
      if (nt8 === null) {
        hoursChecks.delete(templateName);
      } else {
        hoursChecks.set(templateName, {
          nt8Template: nt8.template,
          differences: compareWithNt8Hours(session, nt8),
          nt8Sessions: describeNt8Sessions(nt8),
        });
      }
      const check = hoursChecks.get(templateName);

      const synced =
        `${res.holidays.length} closed, ${res.partialHolidays.length} modified date(s) synced` +
        `, ${timed} with NT8's close time` +
        (noSession > 0 ? `, ${noSession} late begin(s) after the close synced as closed` : "") +
        (untimedLateBegins > 0 ? `, ${untimedLateBegins} late begin(s) left untimed` : "");
      const verdict =
        check === undefined
          ? ""
          : check.differences.length === 0
            ? `; hours match NT8 '${check.nt8Template}'`
            : `; HOURS DIFFER from NT8 '${check.nt8Template}': ${check.differences.join("; ")}`;
      const calendarVerdict =
        calendarDifferences.length === 0
          ? ""
          : `; CALENDAR DIFFERS from NT8: ${calendarDifferences.map((d) => `${d.date} ${d.difference}`).join("; ")}`;
      console.error(`[calendar-sync] ${templateName}: ${synced}${verdict}${calendarVerdict}`);
    },
  });
}

/** Kick a sync whenever NT8 (re)connects. */
export function registerCalendarSyncOnHello(): void {
  registerHelloSync("calendar-sync", () =>
    syncSessionCalendars({ db: defaultDb, request: bridgeRequest }),
  );
}
