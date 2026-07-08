import { describe, it, expect } from "vitest";
import { sessionDayRange, sessionDaysOverlapping } from "../session-day.js";
import { CME_US_INDEX_FUTURES_ETH } from "../templates.js";

const TEMPLATE = CME_US_INDEX_FUTURES_ETH;

const unix = (
  y: number,
  mo1: number, // 1-12
  d: number,
  h: number,
  mi = 0,
): number => Math.floor(Date.UTC(y, mo1 - 1, d, h, mi, 0) / 1000);

describe("sessionDayRange impossible-date guard", () => {
  it.each(["2026-02-30", "2026-13-01", "2026-00-15", "2026-01-32", "2026-04-31"])(
    "throws on impossible calendar date %s instead of rolling over",
    (label) => {
      expect(() => sessionDayRange(label, TEMPLATE)).toThrow(/impossible/);
    },
  );

  it("still rejects malformed labels on format", () => {
    expect(() => sessionDayRange("2026-5-1", TEMPLATE)).toThrow(/bad session-day label/);
  });

  it("still rejects weekend labels via the no-span path (distinct from impossible)", () => {
    // 2026-07-04 is a Saturday — a real calendar date with no session span.
    expect(() => sessionDayRange("2026-07-04", TEMPLATE)).toThrow(/No session span/);
  });
});

describe("sessionDayRange valid dates", () => {
  it("resolves 2026-05-01 (Fri) to Thu 18:00 ET → Fri 17:00 ET (EDT)", () => {
    const { startUnix, endUnix } = sessionDayRange("2026-05-01", TEMPLATE);
    expect(startUnix).toBe(unix(2026, 4, 30, 22)); // Apr 30 18:00 EDT
    expect(endUnix).toBe(unix(2026, 5, 1, 21)); // May 1 17:00 EDT
  });
});

describe("sessionDaysOverlapping regression (guard must not over-reject)", () => {
  it("returns Mon–Fri labels for a full trading week", () => {
    // Mon 2026-05-04 session opens Sun May 3 18:00 EDT; Fri 2026-05-08
    // session closes Fri 17:00 EDT.
    const from = unix(2026, 5, 3, 22);
    const to = unix(2026, 5, 8, 21);
    const days = sessionDaysOverlapping(from, to, TEMPLATE);
    expect(days.map((d) => d.label)).toEqual([
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
      "2026-05-07",
      "2026-05-08",
    ]);
  });
});
