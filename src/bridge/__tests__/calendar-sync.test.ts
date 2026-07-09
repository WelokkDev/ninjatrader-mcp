import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { syncSessionCalendars } from "../calendar-sync.js";
import { loadCalendar, recordObservedClose } from "../../core/sessions/calendar.js";
import { parseMessage } from "../protocol.js";

const TPL = "cme_us_index_futures_eth";

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function calendarResponse(id = "x") {
  return {
    v: 1,
    id,
    type: "session_calendar_response",
    holidays: [{ date: "2027-12-24", description: "Christmas Eve Closure" }],
    partialHolidays: [
      { date: "2027-11-25", isEarlyClose: true, isLateBegin: false, description: "Thanksgiving" },
    ],
  };
}

describe("session_calendar protocol messages", () => {
  it("parses a valid session_calendar_response", () => {
    const r = parseMessage(JSON.stringify(calendarResponse()));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "session_calendar_response") {
      expect(r.message.holidays[0].date).toBe("2027-12-24");
      expect(r.message.partialHolidays[0].isEarlyClose).toBe(true);
    } else {
      throw new Error("wrong type");
    }
  });

  it("rejects a response with malformed entries", () => {
    const bad = { ...calendarResponse(), holidays: [{ date: 20271224 }] };
    const r = parseMessage(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });
});

describe("syncSessionCalendars", () => {
  it("lands declared dates for every registered template with correct kinds and sources", async () => {
    const db = memDb();
    const requested: string[] = [];
    const request = vi.fn(async (_type: string, payload: Record<string, unknown>) => {
      requested.push(payload.tradingHoursTemplate as string);
      return calendarResponse();
    });

    const res = await syncSessionCalendars({ db, request });
    expect(res.failed).toBe(0);
    expect(res.synced).toBe(3); // cme index, nymex energy, comex metals
    expect(new Set(requested).size).toBe(3);

    const cal = loadCalendar(db, TPL);
    expect(cal.get("2027-12-24")).toMatchObject({ kind: "closed", source: "nt8" });
    expect(cal.get("2027-11-25")).toMatchObject({ kind: "modified", source: "nt8" });
    expect(cal.get("2027-11-25")!.closeTime).toBeUndefined(); // NT8 declares dates, never times
  });

  it("preserves observed times and manual rows across a re-sync", async () => {
    const db = memDb();
    loadCalendar(db, TPL); // seed bootstrap
    recordObservedClose(db, TPL, "2026-01-19", "13:00");
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, close_time, source, description)
       VALUES (?, '2027-11-25', 'modified', '12:15', 'manual', 'operator override')`,
    ).run(TPL);

    const request = vi.fn(async () => ({
      ...calendarResponse(),
      partialHolidays: [
        { date: "2026-01-19", isEarlyClose: true, isLateBegin: false, description: "MLK (synced)" },
        { date: "2027-11-25", isEarlyClose: true, isLateBegin: false, description: "sync tries to clobber" },
      ],
    }));
    const res = await syncSessionCalendars({ db, request });
    expect(res.failed).toBe(0);

    const cal = loadCalendar(db, TPL);
    expect(cal.get("2026-01-19")).toMatchObject({ closeTime: "13:00", source: "nt8-observed" });
    expect(cal.get("2027-11-25")).toMatchObject({
      closeTime: "12:15",
      source: "manual",
      description: "operator override",
    });
  });

  it("fails soft per template when the AddOn predates the message", async () => {
    const db = memDb();
    const request = vi.fn(async () => {
      throw new Error("unknown type: request_session_calendar");
    });
    const res = await syncSessionCalendars({ db, request });
    expect(res).toEqual({ synced: 0, failed: 3 });
  });
});
