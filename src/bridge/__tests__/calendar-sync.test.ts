import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { nt8CalendarDifferences, nt8HoursCheck, syncSessionCalendars } from "../calendar-sync.js";
import { EMPTY_CALENDAR, loadCalendar } from "../../core/sessions/calendar.js";
import { getInstrumentConfig } from "../../core/sessions/registry.js";
import { sessionDayRange } from "../../core/sessions/session-day.js";
import { wallClockToUnix } from "../../core/time.js";
import { expectedCloseStamps } from "../../core/cache/validator.js";
import { DERIVED_TIMEFRAMES, recomputeDerivedForSessionDay } from "../../core/cache/derived.js";
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
    expect(cal.get("2027-11-25")!.closeTime).toBeUndefined(); // an older AddOn sends no time
  });

  it("preserves an older database's guessed time and manual rows across a sync without times", async () => {
    const db = memDb();
    loadCalendar(db, TPL); // seed bootstrap
    db.prepare(
      `UPDATE session_calendar SET close_time = '13:00', source = 'nt8-observed' WHERE template = ? AND date = '2026-01-19'`,
    ).run(TPL);
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

describe("NT8 early-close times", () => {
  // NT8 keeps the index template in Central time; ours is Eastern.
  const central = (y: number, mo: number, d: number, h: number, mi: number) =>
    wallClockToUnix(y, mo, d, h, mi, 0, "America/Chicago");

  function earlyClose(date: string, closeUnix: number) {
    return { date, isEarlyClose: true, isLateBegin: false, description: "early close", closeUnix };
  }

  function respondWith(partialHolidays: unknown[]) {
    return vi.fn(async () => ({ ...calendarResponse(), ...globexWeek(), partialHolidays }));
  }

  it("parses the close the AddOn sends", () => {
    const msg = { ...calendarResponse(), partialHolidays: [earlyClose("2026-11-27", 1795889700)] };
    const r = parseMessage(JSON.stringify(msg));
    if (!r.ok || r.message.type !== "session_calendar_response") throw new Error("wrong type");
    expect(r.message.partialHolidays[0].closeUnix).toBe(1795889700);
  });

  it("records NT8's close in the template's own clock, either side of daylight saving", async () => {
    const db = memDb();
    await syncSessionCalendars({
      db,
      request: respondWith([
        earlyClose("2026-07-03", central(2026, 7, 3, 12, 0)),
        earlyClose("2026-11-27", central(2026, 11, 27, 12, 15)),
      ]),
    });
    const cal = loadCalendar(db, TPL);
    expect(cal.get("2026-07-03")).toMatchObject({ kind: "modified", closeTime: "13:00", source: "nt8" });
    expect(cal.get("2026-11-27")).toMatchObject({ kind: "modified", closeTime: "13:15", source: "nt8" });
    expect(nt8CalendarDifferences(TPL)).toEqual([]);
  });

  it("replaces a guessed close, keeps a manual one, and reports the disagreement", async () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, close_time, source)
       VALUES (?, '2026-09-07', 'modified', '12:59', 'nt8-observed')`,
    ).run(TPL);
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, close_time, source)
       VALUES (?, '2026-11-27', 'modified', '13:00', 'manual'), (?, '2026-12-24', 'modified', '13:15', 'manual')`,
    ).run(TPL, TPL);

    await syncSessionCalendars({
      db,
      request: respondWith([
        earlyClose("2026-09-07", central(2026, 9, 7, 12, 0)),
        earlyClose("2026-11-27", central(2026, 11, 27, 12, 15)),
        earlyClose("2026-12-24", central(2026, 12, 24, 12, 15)),
      ]),
    });

    const cal = loadCalendar(db, TPL);
    expect(cal.get("2026-09-07")).toMatchObject({ closeTime: "13:00", source: "nt8" });
    expect(cal.get("2026-11-27")).toMatchObject({ closeTime: "13:00", source: "manual" });
    expect(cal.get("2026-12-24")).toMatchObject({ closeTime: "13:15", source: "manual" });
    expect(nt8CalendarDifferences(TPL)).toEqual([
      { date: "2026-11-27", difference: "closes 13:15 in NT8, 13:00 here (manual, kept)" },
    ]);
    expect(nt8HoursCheck(TPL)!.differences).toEqual([]);
  });

  it("records no close that falls outside the declared day, and doesn't count it", async () => {
    const db = memDb();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await syncSessionCalendars({
      db,
      request: respondWith([
        earlyClose("2026-11-26", central(2026, 11, 26, 12, 0)),
        earlyClose("2026-11-27", central(2026, 11, 26, 19, 0)),
      ]),
    });
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(loadCalendar(db, TPL).get("2026-11-27")!.closeTime).toBeUndefined();
    expect(nt8CalendarDifferences(TPL)).toEqual([
      { date: "2026-11-27", difference: "NT8 closes it at 2026-11-26 20:00, outside its session-day here" },
    ]);
    expect(lines.find((l) => l.startsWith(`[calendar-sync] ${TPL}:`))).toContain(
      "2 modified date(s) synced, 1 with NT8's close time",
    );
  });

  it("syncs a late begin that starts after the day's close as a closed day", async () => {
    const db = memDb();
    const FX = "cme_fx_futures_eth";
    await syncSessionCalendars({
      db,
      request: respondWith([
        // NT8's CME FX Christmas: the session "begins" at 17:00 CT on the 25th.
        { date: "2026-12-25", isEarlyClose: false, isLateBegin: true, description: "Christmas Day", openUnix: central(2026, 12, 25, 17, 0) },
        // A late open inside the day can't be modeled, so it is reported.
        { date: "2026-05-04", isEarlyClose: false, isLateBegin: true, description: "late open", openUnix: central(2026, 5, 3, 20, 0) },
      ]),
    });
    const cal = loadCalendar(db, FX);
    expect(cal.get("2026-12-25")).toMatchObject({ kind: "closed", source: "nt8" });
    expect(cal.get("2026-05-04")).toMatchObject({ kind: "modified" });
    expect(nt8CalendarDifferences(FX)).toEqual([
      { date: "2026-05-04", difference: "NT8 opens it late, at 2026-05-03 21:00; the server keeps the usual open" },
    ]);
  });

  it("rebuilds the day's derived bars for every symbol on the template", async () => {
    const db = memDb();
    const index = getInstrumentConfig("NQ").session;
    const day = { label: "2026-05-04", ...sessionDayRange("2026-05-04", index) };
    const close = day.endUnix - 4 * 3600; // 13:00 ET
    const insert15m = db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES (?, '15m', ?, 1, 2, 0.5, 1.5, 10)`,
    );
    const lastStamp = (symbol: string, tf: string): number =>
      (
        db
          .prepare(`SELECT MAX(timestamp) AS m FROM candles WHERE symbol = ? AND timeframe = ?`)
          .get(symbol, tf) as { m: number }
      ).m;
    const after = day.endUnix + 86400;
    for (const symbol of ["NQ", "MNQ"]) {
      for (const t of expectedCloseStamps({ startUnix: day.startUnix, endUnix: close }, "15m")) {
        insert15m.run(symbol, t);
      }
      recomputeDerivedForSessionDay(db, symbol, day, getInstrumentConfig(symbol), EMPTY_CALENDAR, after);
      expect(lastStamp(symbol, "4h")).toBe(close + 3600);
    }

    await syncSessionCalendars({
      db,
      request: respondWith([earlyClose("2026-05-04", central(2026, 5, 4, 12, 0))]),
      now: () => after,
    });

    for (const symbol of ["NQ", "MNQ"]) {
      for (const tf of DERIVED_TIMEFRAMES) {
        expect(lastStamp(symbol, tf), `${symbol} ${tf}`).toBe(close);
      }
    }
  });
});
