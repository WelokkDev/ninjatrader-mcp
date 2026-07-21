import { describe, it, expect } from "vitest";
import {
  addDaysToLabel,
  currentOrPreviousSessionDay,
  labelWeekday,
  labelWeekdayName,
  mondayOfWeek,
  nearestSessionDays,
  previousSessionDay,
  snapToSessionDay,
  trySessionDayRange,
  weekSessionDays,
} from "../navigation.js";
import { CME_US_INDEX_FUTURES_ETH, CONTINUOUS_24_7, NYSE_RTH } from "../templates.js";
import type { SessionCalendar } from "../calendar.js";

const CME = CME_US_INDEX_FUTURES_ETH;

const unix = (
  y: number,
  mo1: number, // 1-12
  d: number,
  h: number,
  mi = 0,
): number => Math.floor(Date.UTC(y, mo1 - 1, d, h, mi, 0) / 1000);

describe("label arithmetic", () => {
  it("addDaysToLabel normalizes month, year, and leap boundaries", () => {
    expect(addDaysToLabel("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToLabel("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToLabel("2024-02-28", 1)).toBe("2024-02-29"); // leap year
    expect(addDaysToLabel("2026-07-06", 0)).toBe("2026-07-06");
  });

  it("labelWeekday / labelWeekdayName are timezone-independent calendar facts", () => {
    expect(labelWeekday("2026-07-04")).toBe(6); // Saturday
    expect(labelWeekdayName("2026-07-04")).toBe("Sat");
    expect(labelWeekday("2026-07-06")).toBe(1); // Monday
    expect(labelWeekdayName("2026-07-06")).toBe("Mon");
  });

  it("mondayOfWeek anchors any weekday (including Sunday) to that week's Monday", () => {
    expect(mondayOfWeek("2026-07-08")).toBe("2026-07-06"); // Wed → Mon
    expect(mondayOfWeek("2026-07-06")).toBe("2026-07-06"); // Mon → itself
    expect(mondayOfWeek("2026-07-12")).toBe("2026-07-06"); // Sun → preceding Mon
  });

  it("malformed labels throw", () => {
    expect(() => addDaysToLabel("2026-7-6", 1)).toThrow(/bad session-day label/);
    expect(() => labelWeekday("garbage")).toThrow(/bad session-day label/);
  });
});

describe("trySessionDayRange", () => {
  it("maps weekends and holidays to null, keeps session-days", () => {
    expect(trySessionDayRange("2026-07-04", CME)).toBeNull(); // Saturday
    const closed: SessionCalendar = new Map([
      ["2026-07-06", { date: "2026-07-06", kind: "closed" as const, source: "manual" as const }],
    ]);
    expect(trySessionDayRange("2026-07-06", CME, closed)).toBeNull();
    expect(trySessionDayRange("2026-07-06", CME)).not.toBeNull();
  });

  it("propagates data-integrity errors instead of nulling them", () => {
    const inverted: SessionCalendar = new Map([
      ["2026-02-16", { date: "2026-02-16", kind: "modified" as const, closeTime: "09:00", source: "manual" as const }],
    ]);
    expect(() => trySessionDayRange("2026-02-16", NYSE_RTH, inverted)).toThrow(/not after/i);
  });
});

describe("nearestSessionDays / snapToSessionDay", () => {
  it("finds bare labels around a weekend", () => {
    expect(nearestSessionDays("2026-07-04", CME)).toEqual({
      prev: "2026-07-03",
      next: "2026-07-06",
    });
  });

  it("snap: direct hit is not flagged as snapped", () => {
    const res = snapToSessionDay("2026-07-06", CME, 1);
    expect(res.snapped).toBe(false);
    expect(res.day.label).toBe("2026-07-06");
  });

  it("snap: weekends snap directionally", () => {
    expect(snapToSessionDay("2026-07-04", CME, 1).day.label).toBe("2026-07-06");
    expect(snapToSessionDay("2026-07-04", CME, -1).day.label).toBe("2026-07-03");
  });

  it("snap throws when no session-day exists within 7 days", () => {
    // Close out an entire week: Sat 07-04 forward hits Sun (no span) then
    // five closed weekdays then Sat again — nothing within 7 days.
    const entries: [string, { date: string; kind: "closed"; source: "manual" }][] = [];
    for (let d = 6; d <= 10; d++) {
      const date = `2026-07-${String(d).padStart(2, "0")}`;
      entries.push([date, { date, kind: "closed", source: "manual" }]);
    }
    const closedWeek: SessionCalendar = new Map(entries);
    expect(() => snapToSessionDay("2026-07-04", CME, 1, closedWeek)).toThrow(
      /no session-day within 7 days/,
    );
  });
});

describe("currentOrPreviousSessionDay", () => {
  it("mid-session: returns the containing day, not in gap", () => {
    // Tue 2026-07-07 11:00 ET (15:00Z) — inside the Tuesday session.
    const res = currentOrPreviousSessionDay(unix(2026, 7, 7, 15), CME);
    expect(res.inGap).toBe(false);
    expect(res.day.label).toBe("2026-07-07");
  });

  it("maintenance break (17:00-18:00 ET): anchors to the session that just closed", () => {
    // Tue 2026-07-07 17:30 ET (21:30Z).
    const res = currentOrPreviousSessionDay(unix(2026, 7, 7, 21, 30), CME);
    expect(res.inGap).toBe(true);
    expect(res.day.label).toBe("2026-07-07");
  });

  it("weekend: anchors to Friday", () => {
    // Sat 2026-07-11 12:00Z.
    const res = currentOrPreviousSessionDay(unix(2026, 7, 11, 12), CME);
    expect(res.inGap).toBe(true);
    expect(res.day.label).toBe("2026-07-10");
  });
});

describe("previousSessionDay", () => {
  it("walks across a weekend", () => {
    const mon = snapToSessionDay("2026-07-06", CME, 1).day;
    expect(previousSessionDay(mon, CME).label).toBe("2026-07-03");
  });
});

describe("weekSessionDays", () => {
  it("weekly template: Mon-Fri", () => {
    const days = weekSessionDays("2026-07-06", CME);
    expect(days.map((d) => d.label)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ]);
  });

  it("7-day template keeps weekend session-days (regression: was hardcoded to 5)", () => {
    const days = weekSessionDays("2026-07-06", CONTINUOUS_24_7);
    expect(days.map((d) => d.label)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
  });
});
