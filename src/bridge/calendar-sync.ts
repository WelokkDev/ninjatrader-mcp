import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { REGISTRY } from "../core/sessions/registry.js";
import { upsertFromSync } from "../core/sessions/calendar.js";
import {
  compareWithNt8Hours,
  describeNt8Sessions,
  tradingHoursFields,
  type Nt8Hours,
} from "../core/sessions/nt8-hours.js";
import type { SessionTemplate } from "../core/sessions/types.js";
import { request as bridgeRequest } from "./index.js";
import { isInboundType, type SessionCalendarResponseMessage } from "./protocol.js";
import { registerHelloSync, runHelloSync, type HelloSyncResult } from "./hello-sync.js";

// On every NT8 hello, sync each registered template's declared holidays
// (dates only — NT8 exposes no early-close times) and compare its hours with
// NT8's own. Fail-soft: never breaks the connection or the candle path.

export interface CalendarSyncDeps {
  db: Database;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

export interface Nt8HoursCheck {
  nt8Template: string;
  differences: string[];
  nt8Sessions: string;
}

// A failed sync leaves a template's last verdict standing.
const hoursChecks = new Map<string, Nt8HoursCheck>();

export function nt8HoursCheck(templateName: string): Nt8HoursCheck | undefined {
  return hoursChecks.get(templateName);
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

export async function syncSessionCalendars(
  deps: CalendarSyncDeps,
): Promise<HelloSyncResult> {
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
      for (const p of res.partialHolidays) {
        upsertFromSync(deps.db, templateName, {
          date: p.date,
          kind: "modified",
          description: p.description,
        });
      }

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

      const synced = `${res.holidays.length} closed, ${res.partialHolidays.length} modified date(s) synced`;
      const verdict =
        check === undefined
          ? ""
          : check.differences.length === 0
            ? `; hours match NT8 '${check.nt8Template}'`
            : `; HOURS DIFFER from NT8 '${check.nt8Template}': ${check.differences.join("; ")}`;
      console.error(`[calendar-sync] ${templateName}: ${synced}${verdict}`);
    },
  });
}

/** Kick a sync whenever NT8 (re)connects. */
export function registerCalendarSyncOnHello(): void {
  registerHelloSync("calendar-sync", () =>
    syncSessionCalendars({ db: defaultDb, request: bridgeRequest }),
  );
}
