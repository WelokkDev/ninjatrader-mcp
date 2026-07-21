import { describe, it, expect } from "vitest";
import {
  NoSessionSpanError,
  SessionClosedError,
  makeSessionDayResolver,
  sessionDayContaining,
  sessionDayRange,
  sessionDaysOverlapping,
} from "../session-day.js";
import { CME_US_INDEX_FUTURES_ETH, NYSE_RTH } from "../templates.js";
import type { SessionTemplate } from "../types.js";
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

  it("the no-span failure is typed (NoSessionSpanError) with the same message", () => {
    try {
      sessionDayRange("2026-07-04", TEMPLATE);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoSessionSpanError);
      expect((err as NoSessionSpanError).label).toBe("2026-07-04");
      expect((err as Error).message).toMatch(/No session span/);
    }
  });
});

describe("sessionDayRange valid dates", () => {
  it("resolves 2026-05-01 (Fri) to Thu 18:00 ET → Fri 17:00 ET (EDT)", () => {
    const { startUnix, endUnix } = sessionDayRange("2026-05-01", TEMPLATE);
    expect(startUnix).toBe(unix(2026, 4, 30, 22)); // Apr 30 18:00 EDT
    expect(endUnix).toBe(unix(2026, 5, 1, 21)); // May 1 17:00 EDT
  });
});

describe("sessionDayRange across DST transition weekends", () => {
  it("Monday session over spring forward: Sun 2026-03-08 18:00 EDT → Mon 17:00 EDT (23h session)", () => {
    const { startUnix, endUnix } = sessionDayRange("2026-03-09", TEMPLATE);
    expect(startUnix).toBe(unix(2026, 3, 8, 22)); // Sun 18:00 EDT (post-transition)
    expect(endUnix).toBe(unix(2026, 3, 9, 21)); // Mon 17:00 EDT
    expect(endUnix - startUnix).toBe(23 * 3600);
  });

  it("Monday session over fall back: Sun 2026-11-01 18:00 EST → Mon 17:00 EST (23h session)", () => {
    const { startUnix, endUnix } = sessionDayRange("2026-11-02", TEMPLATE);
    expect(startUnix).toBe(unix(2026, 11, 1, 23)); // Sun 18:00 EST (post-transition)
    expect(endUnix).toBe(unix(2026, 11, 2, 22)); // Mon 17:00 EST
    expect(endUnix - startUnix).toBe(23 * 3600);
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

describe("enumeration paths propagate data-integrity errors loudly", () => {
  // Expected "not a session-day" outcomes (weekend, holiday) are skipped
  // silently; a corrupt calendar row must NOT silently vanish a day from
  // cache fill / validation — it throws out of the enumeration.
  const inverted: SessionCalendar = new Map([
    ["2026-02-16", { date: "2026-02-16", kind: "modified" as const, closeTime: "09:00", source: "manual" as const }],
  ]);
  const malformed: SessionCalendar = new Map([
    ["2026-02-16", { date: "2026-02-16", kind: "modified" as const, closeTime: "9:00", source: "manual" as const }],
  ]);

  it("sessionDaysOverlapping throws on an inverted override instead of skipping the day", () => {
    expect(() =>
      sessionDaysOverlapping(unix(2026, 2, 16, 0), unix(2026, 2, 17, 0), NYSE_RTH, inverted),
    ).toThrow(/not after/i);
  });

  it("sessionDayContaining throws on an inverted override instead of returning null", () => {
    // Mon 2026-02-16 12:00 EST — the corrupt label is a containment candidate.
    expect(() => sessionDayContaining(unix(2026, 2, 16, 17), NYSE_RTH, inverted)).toThrow(
      /not after/i,
    );
  });

  it("malformed override time strings also propagate", () => {
    expect(() =>
      sessionDaysOverlapping(unix(2026, 2, 16, 0), unix(2026, 2, 17, 0), NYSE_RTH, malformed),
    ).toThrow(/bad time string/);
  });

  it("weekends and holidays are still skipped silently", () => {
    const holiday: SessionCalendar = new Map([
      ["2026-02-16", { date: "2026-02-16", kind: "closed" as const, source: "manual" as const }],
    ]);
    // Sat 2026-02-14 through Tue 2026-02-17 with Monday closed: only Tuesday remains.
    const days = sessionDaysOverlapping(unix(2026, 2, 14, 0), unix(2026, 2, 18, 0), NYSE_RTH, holiday);
    expect(days.map((d) => d.label)).toEqual(["2026-02-17"]);
  });
});

describe("makeSessionDayResolver (memoized sessionDayContaining)", () => {
  // Tue 2026-06-09 session: Mon Jun 8 18:00 EDT → Tue Jun 9 17:00 EDT.
  const TUE = sessionDayRange("2026-06-09", TEMPLATE);

  it("matches sessionDayContaining across days, gaps, and the weekend — sorted and reversed", () => {
    const stamps: number[] = [];
    for (const label of ["2026-06-05", "2026-06-08", "2026-06-09"]) {
      const { startUnix, endUnix } = sessionDayRange(label, TEMPLATE);
      for (let t = startUnix + 900; t <= endUnix; t += 900) stamps.push(t);
      stamps.push(endUnix + 1800); // maintenance gap / weekend after the close
    }
    stamps.push(unix(2026, 6, 6, 16)); // Sat noon ET

    const forward = makeSessionDayResolver(TEMPLATE);
    for (const ts of stamps) {
      expect(forward(ts)).toEqual(sessionDayContaining(ts, TEMPLATE));
    }
    const backward = makeSessionDayResolver(TEMPLATE);
    for (const ts of [...stamps].reverse()) {
      expect(backward(ts)).toEqual(sessionDayContaining(ts, TEMPLATE));
    }
  });

  it("honors the (startUnix, endUnix] boundaries even with a warm memo", () => {
    const resolve = makeSessionDayResolver(TEMPLATE);
    expect(resolve(TUE.startUnix + 900)?.label).toBe("2026-06-09"); // warm the memo
    expect(resolve(TUE.endUnix)?.label).toBe("2026-06-09"); // close instant is in
    expect(resolve(TUE.endUnix + 1)).toBeNull(); // first gap second is out
    expect(resolve(TUE.startUnix)).toBeNull(); // open instant is exclusive
  });

  it("returns the cached day object for same-day stamps and re-resolves across days", () => {
    const resolve = makeSessionDayResolver(TEMPLATE);
    const first = resolve(TUE.startUnix + 900);
    expect(resolve(TUE.startUnix + 1800)).toBe(first); // memo hit: same object
    const wed = resolve(TUE.startUnix + 90000); // next session-day
    expect(wed?.label).toBe("2026-06-10");
    expect(resolve(TUE.startUnix + 900)).not.toBe(first); // one-entry memo was evicted
  });

  it("never memoizes for a template with within-session breaks (in-break stays null)", () => {
    const withLunch: SessionTemplate = {
      ...NYSE_RTH,
      name: "nyse_rth_with_lunch",
      breaks: [{ startTime: "12:00", endTime: "13:00" }],
    };
    const resolve = makeSessionDayResolver(withLunch);
    // Mon 2026-06-08, EDT: 11:00 → 15:00 UTC, 12:30 → 16:30 UTC, 14:00 → 18:00 UTC.
    const morning = resolve(unix(2026, 6, 8, 15));
    expect(morning?.label).toBe("2026-06-08");
    // In-break must resolve null even though the range test would pass.
    expect(resolve(unix(2026, 6, 8, 16, 30))).toBeNull();
    expect(sessionDayContaining(unix(2026, 6, 8, 16, 30), withLunch)).toBeNull();
    const afternoon = resolve(unix(2026, 6, 8, 18));
    expect(afternoon?.label).toBe("2026-06-08");
    expect(afternoon).not.toBe(morning); // unmemoized path: fresh object per call
  });

  it("respects a calendar early close after a warm same-day hit", () => {
    const cal: SessionCalendar = new Map([
      ["2026-02-16", { date: "2026-02-16", kind: "modified" as const, closeTime: "13:00", source: "bootstrap" as const }],
    ]);
    const resolve = makeSessionDayResolver(TEMPLATE, cal);
    const inDay = resolve(unix(2026, 2, 16, 17)); // 12:00 EST
    expect(inDay?.label).toBe("2026-02-16");
    expect(inDay?.endUnix).toBe(unix(2026, 2, 16, 18)); // 13:00 EST close
    expect(resolve(unix(2026, 2, 16, 19))).toBeNull(); // 14:00 EST: after early close
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
