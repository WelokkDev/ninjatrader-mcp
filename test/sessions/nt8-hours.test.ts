import { describe, it, expect } from "vitest";
import {
  compareWithNt8Hours,
  describeNt8Sessions,
  tradingHoursFields,
  type Nt8Hours,
  type Nt8Session,
} from "../../src/core/sessions/nt8-hours.js";
import { CME_US_INDEX_FUTURES_ETH } from "../../src/core/sessions/templates.js";

const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;

function row(
  beginDay: number, beginTime: number, endDay: number, endTime: number, tradingDay: number,
): Nt8Session {
  return { beginDay, beginTime, endDay, endTime, tradingDay };
}

function central(sessions: Nt8Session[]): Nt8Hours {
  return {
    template: "CME US Index Futures ETH",
    timeZone: "Central Standard Time",
    utcOffsetMinutes: -360,
    observesDst: true,
    sessions,
  };
}

const GLOBEX_WEEK = [SUN, MON, TUE, WED, THU].map((d) => row(d, 1700, d + 1, 1600, d + 1));

describe("tradingHoursFields", () => {
  it("names NT8's template when the session template has one", () => {
    expect(tradingHoursFields(CME_US_INDEX_FUTURES_ETH)).toEqual({
      tradingHoursTemplate: "cme_us_index_futures_eth",
      nt8TradingHours: "CME US Index Futures ETH",
    });
  });

  it("sends only the key when it has none", () => {
    expect(tradingHoursFields({ ...CME_US_INDEX_FUTURES_ETH, nt8TradingHours: undefined })).toEqual({
      tradingHoursTemplate: "cme_us_index_futures_eth",
    });
  });
});

describe("compareWithNt8Hours", () => {
  it("matches the same week written in another time zone", () => {
    expect(compareWithNt8Hours(CME_US_INDEX_FUTURES_ETH, central(GLOBEX_WEEK))).toEqual([]);
  });

  it("matches the same week written in the server's own zone", () => {
    const eastern: Nt8Hours = {
      template: "CME US Index Futures ETH",
      timeZone: "Eastern Standard Time",
      utcOffsetMinutes: -300,
      observesDst: true,
      sessions: [SUN, MON, TUE, WED, THU].map((d) => row(d, 1800, d + 1, 1700, d + 1)),
    };
    expect(compareWithNt8Hours(CME_US_INDEX_FUTURES_ETH, eastern)).toEqual([]);
  });

  it("reports a regular-hours template against an overnight one", () => {
    const rth = central([MON, TUE, WED, THU, FRI].map((d) => row(d, 830, d, 1515, d)));
    const diff = compareWithNt8Hours(CME_US_INDEX_FUTURES_ETH, rth);
    expect(diff).toContain("Mon opens Mon 09:30 in NT8, Sun 18:00 here");
    expect(diff).toContain("Mon closes Mon 16:15 in NT8, Mon 17:00 here");
    expect(diff).toHaveLength(10);
  });

  it("joins a trading day NT8 writes as several rows, pause and all", () => {
    const split = central([
      row(SUN, 1700, MON, 800, MON),
      row(MON, 830, MON, 1600, MON),
      ...GLOBEX_WEEK.slice(1),
    ]);
    expect(compareWithNt8Hours(CME_US_INDEX_FUTURES_ETH, split)).toEqual([]);
  });

  it("reports a session-day only one side has", () => {
    const withSaturday = central([...GLOBEX_WEEK, row(SAT, 800, SAT, 1200, SAT)]);
    expect(compareWithNt8Hours(CME_US_INDEX_FUTURES_ETH, withSaturday)).toEqual([
      "Sat: NT8 has a session-day the server lacks (Sat 09:00 → Sat 13:00)",
    ]);
    expect(compareWithNt8Hours(CME_US_INDEX_FUTURES_ETH, central(GLOBEX_WEEK.slice(1)))).toEqual([
      "Mon: NT8 has no session-day (here Sun 18:00 → Mon 17:00)",
    ]);
  });

  it("says so when the two zones disagree on daylight saving", () => {
    const utc: Nt8Hours = {
      template: "Default 24 x 7",
      timeZone: "UTC",
      utcOffsetMinutes: 0,
      observesDst: false,
      sessions: [SUN, MON, TUE, WED, THU, FRI, SAT].map((d) => row(d, 0, (d + 1) % 7, 0, d)),
    };
    const diff = compareWithNt8Hours(CME_US_INDEX_FUTURES_ETH, utc);
    expect(diff[0]).toMatch(/UTC, which has no daylight saving, unlike America\/New_York/);
    expect(diff.length).toBeGreaterThan(1);
  });

  it("refuses to compare a row it cannot read", () => {
    const diff = compareWithNt8Hours(
      CME_US_INDEX_FUTURES_ETH,
      central([row(SUN, 1775, MON, 1600, MON)]),
    );
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatch(/unreadable/);
  });
});

describe("describeNt8Sessions", () => {
  it("writes the rows as NT8 lists them", () => {
    expect(describeNt8Sessions(central([row(FRI, 1600, SAT, 200, MON), row(SAT, 400, SUN, 1600, MON)]))).toBe(
      "Fri 16:00 → Sat 02:00 [Mon], Sat 04:00 → Sun 16:00 [Mon] (Central Standard Time)",
    );
  });
});
