import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { REGISTRY } from "../core/sessions/registry.js";
import { upsertFromSync } from "../core/sessions/calendar.js";
import { request as bridgeRequest } from "./index.js";
import { isInboundType } from "./protocol.js";
import { registerHelloSync, runHelloSync, type HelloSyncResult } from "./hello-sync.js";

// On every NT8 hello, sync each registered template's declared holidays
// (dates only — NT8 exposes no early-close times). Fail-soft: never breaks
// the connection or the candle path.

export interface CalendarSyncDeps {
  db: Database;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

export async function syncSessionCalendars(
  deps: CalendarSyncDeps,
): Promise<HelloSyncResult> {
  // Set IS load-bearing here: several symbols share a session template.
  const templates = [...new Set(Object.values(REGISTRY).map((c) => c.session.name))];

  return runHelloSync({
    label: "calendar-sync",
    requestType: "request_session_calendar",
    items: templates,
    syncOne: async (templateName) => {
      const res = await deps.request("request_session_calendar", {
        tradingHoursTemplate: templateName,
      });
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
      console.error(
        `[calendar-sync] ${templateName}: ${res.holidays.length} closed, ${res.partialHolidays.length} modified date(s) synced`,
      );
    },
  });
}

/** Kick a sync whenever NT8 (re)connects. */
export function registerCalendarSyncOnHello(): void {
  registerHelloSync("calendar-sync", () =>
    syncSessionCalendars({ db: defaultDb, request: bridgeRequest }),
  );
}
