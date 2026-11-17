import { existsSync } from "node:fs";
import path from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { BOOTSTRAP_CALENDARS } from "../core/sessions/calendars/bootstrap.js";
import type { CalendarEntry, CalendarSource, SessionCalendar } from "../core/sessions/calendar.js";
import { dataDir } from "../hub/config.js";
import type { RefBar, ReferenceBars } from "./checks.js";
import { identify } from "./layout.js";

// Read-only view of the candle cache: never db/connection.ts, which migrates on open.

export function openCache(file: string = path.join(dataDir(), "candles.db")): DatabaseType | null {
  if (!existsSync(file)) return null;
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** loadCalendar's result without its bootstrap seeding write. */
export function readCalendar(db: DatabaseType | null, templateName: string): SessionCalendar {
  const map = new Map<string, CalendarEntry>();
  for (const e of BOOTSTRAP_CALENDARS[templateName] ?? []) {
    map.set(e.date, {
      date: e.date,
      kind: e.kind,
      ...(e.closeTime !== undefined && { closeTime: e.closeTime }),
      ...(e.openTime !== undefined && { openTime: e.openTime }),
      source: "bootstrap",
      description: e.description,
    });
  }
  if (db === null) return map;
  const stored = db
    .prepare(`SELECT date, kind, close_time, open_time, source, description FROM session_calendar WHERE template = ?`)
    .all(templateName) as {
    date: string;
    kind: "closed" | "modified";
    close_time: string | null;
    open_time: string | null;
    source: CalendarSource;
    description: string | null;
  }[];
  for (const r of stored) {
    map.set(r.date, {
      date: r.date,
      kind: r.kind,
      ...(r.close_time !== null && { closeTime: r.close_time }),
      ...(r.open_time !== null && { openTime: r.open_time }),
      source: r.source,
      ...(r.description !== null && { description: r.description }),
    });
  }
  return map;
}

/** The cache's per-contract `bars` table, not the front-contract `candles` view. */
export function cacheReferenceBars(db: DatabaseType | null): ReferenceBars {
  return async (contract, cutFrom, cutTo) => {
    if (db === null) throw new Error("no candle cache (candles.db) to read");
    return db
      .prepare(
        `SELECT timestamp, open, high, low, close, volume FROM bars
         WHERE symbol = ? AND timeframe = '1s' AND contract = ? AND price_basis = 'as_traded'
           AND timestamp > ? AND timestamp <= ?
         ORDER BY timestamp`,
      )
      .all(identify(contract).symbol, contract, cutFrom, cutTo) as RefBar[];
  };
}
