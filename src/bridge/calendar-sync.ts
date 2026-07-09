import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { REGISTRY } from "../core/sessions/registry.js";
import { upsertFromSync } from "../core/sessions/calendar.js";
import { onMessage, request as bridgeRequest } from "./index.js";
import type { SessionCalendarResponseMessage } from "./protocol.js";

// On every NT8 hello, ask the AddOn for each registered template's
// declared holidays (dates only — NT8 exposes no early-close times; the
// observed-close interlock supplies those). Fail-soft: an AddOn predating
// request_session_calendar answers with an error, which must never break
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
): Promise<{ synced: number; failed: number }> {
  const templates = [...new Set(Object.values(REGISTRY).map((c) => c.session.name))];
  let synced = 0;
  let failed = 0;

  for (const templateName of templates) {
    try {
      const res = (await deps.request("request_session_calendar", {
        tradingHoursTemplate: templateName,
      })) as SessionCalendarResponseMessage;
      for (const h of res.holidays ?? []) {
        upsertFromSync(deps.db, templateName, {
          date: h.date,
          kind: "closed",
          description: h.description,
        });
      }
      for (const p of res.partialHolidays ?? []) {
        upsertFromSync(deps.db, templateName, {
          date: p.date,
          kind: "modified",
          description: p.description,
        });
      }
      synced++;
      console.error(
        `[calendar-sync] ${templateName}: ${res.holidays?.length ?? 0} closed, ${res.partialHolidays?.length ?? 0} modified date(s) synced`,
      );
    } catch (err) {
      failed++;
      const m = err instanceof Error ? err.message : String(err);
      console.error(
        `[calendar-sync] ${templateName} failed (AddOn may predate request_session_calendar): ${m}`,
      );
    }
  }

  return { synced, failed };
}

/** Kick a sync whenever NT8 (re)connects. */
export function registerCalendarSyncOnHello(): void {
  onMessage("hello", () => {
    void syncSessionCalendars({ db: defaultDb, request: bridgeRequest }).catch((err) => {
      console.error("[calendar-sync] unexpected failure:", err);
    });
  });
}
