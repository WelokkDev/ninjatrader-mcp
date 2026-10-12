import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { nt8HoursCheck, syncSessionCalendars } from "../calendar-sync.js";
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

function globexWeek(beginTime = 1700) {
  return {
    template: "CME US Index Futures ETH",
    timeZone: "Central Standard Time",
    utcOffsetMinutes: -360,
    observesDst: true,
    sessions: [0, 1, 2, 3, 4].map((d) => ({
      beginDay: d, beginTime, endDay: d + 1, endTime: 1600, tradingDay: d + 1,
    })),
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

  it("keeps the template's own definition when the AddOn sends it", () => {
    const r = parseMessage(JSON.stringify({ ...calendarResponse(), ...globexWeek() }));
    if (!r.ok || r.message.type !== "session_calendar_response") throw new Error("wrong type");
    expect(r.message.template).toBe("CME US Index Futures ETH");
    expect(r.message.utcOffsetMinutes).toBe(-360);
    expect(r.message.sessions).toHaveLength(5);
  });
});

describe("syncSessionCalendars", () => {
  it("lands declared dates for every registered template with correct kinds and sources", async () => {
    const db = memDb();
    const requested: string[] = [];
    const request = vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === "request_session_calendar") requested.push(payload.tradingHoursTemplate as string);
      return calendarResponse();
    });

    const res = await syncSessionCalendars({ db, request });
    expect(res.failed).toBe(0);
    expect(res.synced).toBe(4); // cme index, nymex energy, comex metals, cme fx
    expect(new Set(requested).size).toBe(4);

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

  it("names NT8's template in every calendar request", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (_type: string, payload: Record<string, unknown>) => {
      payloads.push(payload);
      return calendarResponse();
    });
    await syncSessionCalendars({ db: memDb(), request });
    expect(payloads).toContainEqual({
      tradingHoursTemplate: "nymex_energy_eth",
      nt8TradingHours: "Nymex Metals - Energy ETH",
    });
  });

  it("records agreement, and where NT8's hours differ", async () => {
    const same = vi.fn(async () => ({ ...calendarResponse(), ...globexWeek() }));
    await syncSessionCalendars({ db: memDb(), request: same });
    expect(nt8HoursCheck(TPL)).toMatchObject({ differences: [] });

    const later = vi.fn(async () => ({ ...calendarResponse(), ...globexWeek(1800) }));
    await syncSessionCalendars({ db: memDb(), request: later });
    expect(nt8HoursCheck(TPL)!.differences).toContain("Mon opens Sun 19:00 in NT8, Sun 18:00 here");
  });

  it("keeps the last verdict when a later sync fails", async () => {
    const later = vi.fn(async () => ({ ...calendarResponse(), ...globexWeek(1800) }));
    await syncSessionCalendars({ db: memDb(), request: later });
    const down = vi.fn(async () => {
      throw new Error("timed out");
    });
    await syncSessionCalendars({ db: memDb(), request: down });
    expect(nt8HoursCheck(TPL)!.differences).toContain("Mon opens Sun 19:00 in NT8, Sun 18:00 here");
  });

  it("has nothing to say about hours when the AddOn sends no session rows", async () => {
    const request = vi.fn(async () => calendarResponse());
    await syncSessionCalendars({ db: memDb(), request });
    expect(nt8HoursCheck(TPL)).toBeUndefined();
  });

  it("fails soft per template when the AddOn predates the message", async () => {
    const db = memDb();
    const request = vi.fn(async () => {
      throw new Error("unknown type: request_session_calendar");
    });
    const res = await syncSessionCalendars({ db, request });
    expect(res).toEqual({ synced: 0, failed: 4 });
  });
});
