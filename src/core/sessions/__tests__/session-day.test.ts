import { describe, it, expect } from "vitest";
import {
  SessionClosedError,
  sessionDayContaining,
  sessionDayRange,
  sessionDaysOverlapping,
} from "../session-day.js";
import { CME_US_INDEX_FUTURES_ETH, NYSE_RTH } from "../templates.js";
import type { SessionCalendar } from "../calendar.js";

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

describe("calendar-aware geometry", () => {
  const CAL: SessionCalendar = new Map([
    [
      "2026-02-16",
      { date: "2026-02-16", kind: "modified" as const, closeTime: "13:00", source: "bootstrap" as const, description: "Presidents Day" },
    ],
    [
      "2026-02-20",
      { date: "2026-02-20", kind: "closed" as const, source: "bootstrap" as const, description: "Test Closure" },
    ],
    [
      "2026-02-17",
      { date: "2026-02-17", kind: "modified" as const, openTime: "20:00", source: "manual" as const },
    ],
  ]);

  it("overrides endUnix on an early-close day (13:00 EST)", () => {
    const { startUnix, endUnix } = sessionDayRange("2026-02-16", TEMPLATE, CAL);
    // Open unchanged: Sun Feb 15 18:00 EST = 23:00 UTC.
    expect(startUnix).toBe(unix(2026, 2, 15, 23));
    // Close overridden: Mon Feb 16 13:00 EST = 18:00 UTC (template says 17:00).
    expect(endUnix).toBe(unix(2026, 2, 16, 18));
  });

  it("overrides startUnix on a late-begin day", () => {
    const { startUnix, endUnix } = sessionDayRange("2026-02-17", TEMPLATE, CAL);
    // Open overridden to Mon Feb 16 20:00 EST = Tue 01:00 UTC.
    expect(startUnix).toBe(unix(2026, 2, 17, 1));
    expect(endUnix).toBe(unix(2026, 2, 17, 22)); // normal Tue 17:00 EST close
  });

  it('open "24:00" means midnight of the next calendar day (late begin on the close date)', () => {
    // Good Friday shape: no prior-evening span at all; the session runs
    // 00:00 → 09:15 on the close date itself.
    const cal: SessionCalendar = new Map([
      [
        "2026-04-03",
        { date: "2026-04-03", kind: "modified" as const, openTime: "24:00", closeTime: "09:15", source: "manual" as const, description: "Good Friday" },
      ],
    ]);
    const { startUnix, endUnix } = sessionDayRange("2026-04-03", TEMPLATE, cal);
    expect(startUnix).toBe(unix(2026, 4, 3, 4)); // Fri 00:00 EDT
    expect(endUnix).toBe(unix(2026, 4, 3, 13) + 900); // Fri 09:15 EDT
  });

  it("throws SessionClosedError with the description on closed days", () => {
    expect(() => sessionDayRange("2026-02-20", TEMPLATE, CAL)).toThrow(SessionClosedError);
    expect(() => sessionDayRange("2026-02-20", TEMPLATE, CAL)).toThrow(/Test Closure/);
  });

  it("containment respects the adjusted close: 12:00 in, 14:00 out", () => {
    const at1200 = sessionDayContaining(unix(2026, 2, 16, 17), TEMPLATE, CAL); // 12:00 EST
    expect(at1200?.label).toBe("2026-02-16");
    expect(at1200?.endUnix).toBe(unix(2026, 2, 16, 18));
    const at1400 = sessionDayContaining(unix(2026, 2, 16, 19), TEMPLATE, CAL); // 14:00 EST
    expect(at1400).toBeNull();
  });

  it("enumeration excludes closed days like weekends", () => {
    // Mon 2026-02-16 .. Fri 2026-02-20 with Friday closed.
    const days = sessionDaysOverlapping(
      unix(2026, 2, 15, 23),
      unix(2026, 2, 20, 22),
      TEMPLATE,
      CAL,
    );
    expect(days.map((d) => d.label)).toEqual([
      "2026-02-16",
      "2026-02-17",
      "2026-02-18",
      "2026-02-19",
    ]);
    expect(days[0].endUnix).toBe(unix(2026, 2, 16, 18)); // early close honored
  });

  it("without a calendar, behavior is byte-identical to the two-arg call", () => {
    const plain = sessionDayRange("2026-02-16", TEMPLATE);
    const empty = sessionDayRange("2026-02-16", TEMPLATE, new Map());
    expect(empty).toEqual(plain);
    expect(plain.endUnix).toBe(unix(2026, 2, 16, 22)); // template 17:00 EST
  });

  it("rejects a calendar override that closes before the open", () => {
    // Only expressible on a same-day span (NYSE RTH 09:30→16:00): a close
    // override earlier than the open. Cross-midnight CME spans can't invert.
    const bad: SessionCalendar = new Map([
      ["2026-02-16", { date: "2026-02-16", kind: "modified" as const, closeTime: "09:00", source: "manual" as const }],
    ]);
    expect(() => sessionDayRange("2026-02-16", NYSE_RTH, bad)).toThrow(/not after/i);
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
