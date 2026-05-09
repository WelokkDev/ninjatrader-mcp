import { describe, it, expect } from "vitest";
import {
  sessionDayContaining,
  sessionDayRange,
  sessionDaysOverlapping,
} from "../../src/core/sessions/session-day.js";
import {
  CME_US_INDEX_FUTURES_ETH,
  CONTINUOUS_24_7,
  NYSE_RTH,
} from "../../src/core/sessions/templates.js";

// DST-safe ET-instant helper. Computes the unix-second timestamp for a
// wall-clock instant in America/New_York, regardless of EST/EDT. Use this
// in tests instead of hardcoded `-04:00` / `-05:00` offsets.
function et(yyyymmddhhmmss: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(yyyymmddhhmmss);
  if (!m) throw new Error(`bad ET instant: ${yyyymmddhhmmss}`);
  const [, y, mo, d, hh, mm, ss] = m;
  // Probe at noon UTC on the same calendar day; back out the ET offset.
  const probeMs = Date.UTC(+y, +mo - 1, +d, 12, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(probeMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const localAsUtcMs = Date.UTC(
    +get("year"), +get("month") - 1, +get("day"),
    +get("hour"), +get("minute"), +get("second"),
  );
  const offsetMs = localAsUtcMs - probeMs;
  return Math.floor(
    (Date.UTC(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0) - offsetMs) / 1000,
  );
}

// UTC-instant helper for 24/7 tests.
function utc(yyyymmddhhmmss: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(yyyymmddhhmmss);
  if (!m) throw new Error(`bad UTC instant: ${yyyymmddhhmmss}`);
  const [, y, mo, d, hh, mm, ss] = m;
  return Math.floor(Date.UTC(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0) / 1000);
}

describe("sessionDayRange — CME ETH", () => {
  // 2026-04-21 is a Tuesday in EDT.
  it("session-day Tue 2026-04-21 spans Mon 18:00 ET → Tue 17:00 ET", () => {
    const range = sessionDayRange("2026-04-21", CME_US_INDEX_FUTURES_ETH);
    expect(range.startUnix).toBe(et("2026-04-20T18:00:00"));
    expect(range.endUnix).toBe(et("2026-04-21T17:00:00"));
  });

  // 2026-04-20 is a Monday — its session opens Sun 18:00 ET.
  it("session-day Mon 2026-04-20 spans Sun 18:00 ET → Mon 17:00 ET", () => {
    const range = sessionDayRange("2026-04-20", CME_US_INDEX_FUTURES_ETH);
    expect(range.startUnix).toBe(et("2026-04-19T18:00:00"));
    expect(range.endUnix).toBe(et("2026-04-20T17:00:00"));
  });

  it("throws when label falls on Saturday (no ETH session closes Sat)", () => {
    // 2026-04-25 is a Saturday.
    expect(() => sessionDayRange("2026-04-25", CME_US_INDEX_FUTURES_ETH)).toThrow();
  });

  it("throws when label falls on Sunday (no ETH session closes Sun)", () => {
    // 2026-04-26 is a Sunday.
    expect(() => sessionDayRange("2026-04-26", CME_US_INDEX_FUTURES_ETH)).toThrow();
  });
});

describe("sessionDayContaining — CME ETH boundary semantics (open-exclusive, close-inclusive)", () => {
  const tpl = CME_US_INDEX_FUTURES_ETH;

  // Per design D.6 + "things to watch for #6": these two boundary cases
  // are non-negotiable.
  it("at exact endUnix (Tue 17:00:00 ET) returns the closing session-day", () => {
    const sd = sessionDayContaining(et("2026-04-21T17:00:00"), tpl);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-21");
  });

  it("at exact startUnix (Mon 18:00:00 ET = open) returns null (open exclusive)", () => {
    // The bar at exactly Mon 18:00:00 ET would be the close-stamp of a bar
    // whose data window is in the maintenance break (17:45–17:59:59 ET).
    // Per the empirical NT8 verification, no such bar should exist; if it
    // arrives, sessionDayContaining must return null so it's dropped.
    const sd = sessionDayContaining(et("2026-04-20T18:00:00"), tpl);
    expect(sd).toBeNull();
  });

  it("at first in-session 15m close-stamp (Mon 18:15 ET) returns Tue's session-day (the new session that just opened)", () => {
    // Mon 18:15 ET is the first in-session bar of the session that
    // CLOSES on Tue. Mon's own session-day already closed at Mon 17:00.
    const sd = sessionDayContaining(et("2026-04-20T18:15:00"), tpl);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-21");
  });

  it("17:30 ET is in the maintenance break — returns null", () => {
    const sd = sessionDayContaining(et("2026-04-21T17:30:00"), tpl);
    expect(sd).toBeNull();
  });

  it("18:00 ET close-stamp (data 17:45–17:59:59 in the break) — returns null", () => {
    const sd = sessionDayContaining(et("2026-04-21T18:00:00"), tpl);
    expect(sd).toBeNull();
  });

  it("18:15 ET on Tue → session-day Wed (next session)", () => {
    const sd = sessionDayContaining(et("2026-04-21T18:15:00"), tpl);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-22");
  });

  it("Saturday noon ET — no session", () => {
    // 2026-04-25 Sat 12:00 ET
    const sd = sessionDayContaining(et("2026-04-25T12:00:00"), tpl);
    expect(sd).toBeNull();
  });

  it("Sunday noon ET — no session (Sun session opens 18:00)", () => {
    const sd = sessionDayContaining(et("2026-04-26T12:00:00"), tpl);
    expect(sd).toBeNull();
  });

  it("Sun 18:15 ET → session-day Mon (Sun's open is 18:00, first bar at 18:15)", () => {
    const sd = sessionDayContaining(et("2026-04-26T18:15:00"), tpl);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-27"); // Mon
  });
});

describe("sessionDayContaining — DST handling", () => {
  // Spring-forward: 2026-03-08 (Sun) at 02:00 ET, clocks jump to 03:00.
  // The session-day Mon 2026-03-09 opens Sun 18:00 (still EST) and closes
  // Mon 17:00 (now EDT). The session is 22 hours wall-clock minus 1 hour
  // gone = effectively 22 hours, but startUnix and endUnix should be
  // computed correctly via Intl.
  it("EST: session-day Fri 2026-01-09 spans Thu 18:00 → Fri 17:00 EST", () => {
    const range = sessionDayRange("2026-01-09", CME_US_INDEX_FUTURES_ETH);
    expect(range.startUnix).toBe(et("2026-01-08T18:00:00"));
    expect(range.endUnix).toBe(et("2026-01-09T17:00:00"));
  });

  it("EDT: session-day Fri 2026-07-10 spans Thu 18:00 → Fri 17:00 EDT", () => {
    const range = sessionDayRange("2026-07-10", CME_US_INDEX_FUTURES_ETH);
    expect(range.startUnix).toBe(et("2026-07-09T18:00:00"));
    expect(range.endUnix).toBe(et("2026-07-10T17:00:00"));
  });
});

describe("sessionDaysOverlapping — CME ETH", () => {
  it("returns the five Mon-Fri sessions for one calendar week of bars", () => {
    // Range covering all of Mon 2026-04-20 through Fri 2026-04-24, in ET.
    const from = et("2026-04-20T00:00:00");
    const to   = et("2026-04-25T00:00:00");
    const days = sessionDaysOverlapping(from, to, CME_US_INDEX_FUTURES_ETH);
    expect(days.map((d) => d.label)).toEqual([
      "2026-04-20", // Mon
      "2026-04-21", // Tue
      "2026-04-22", // Wed
      "2026-04-23", // Thu
      "2026-04-24", // Fri
    ]);
  });

  it("returns the single overlapping session-day for a tight Tue intraday range", () => {
    const from = et("2026-04-21T08:00:00");
    const to   = et("2026-04-21T12:00:00");
    const days = sessionDaysOverlapping(from, to, CME_US_INDEX_FUTURES_ETH);
    expect(days.map((d) => d.label)).toEqual(["2026-04-21"]);
  });

  it("includes the session-day whose endUnix == fromUnix (overlap test is endUnix >= fromUnix)", () => {
    // fromUnix exactly at Tue 17:00 ET (= endUnix of session-day Tue).
    const from = et("2026-04-21T17:00:00");
    const to   = et("2026-04-21T17:00:01");
    const days = sessionDaysOverlapping(from, to, CME_US_INDEX_FUTURES_ETH);
    expect(days.map((d) => d.label)).toContain("2026-04-21");
  });
});

describe("sessionDayContaining — 24/7 (CONTINUOUS_24_7)", () => {
  // 2026-04-21 is a Tuesday (UTC and ET).
  it("Tue 12:00 UTC → session-day Tue", () => {
    const sd = sessionDayContaining(utc("2026-04-21T12:00:00"), CONTINUOUS_24_7);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-21");
  });

  it("Tue 23:59:59 UTC → session-day Tue (close-inclusive end at Wed 00:00:00)", () => {
    const sd = sessionDayContaining(utc("2026-04-21T23:59:59"), CONTINUOUS_24_7);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-21");
  });

  it("Wed 00:00:00 UTC = Tue 24:00 close-stamp → session-day Tue (close-inclusive)", () => {
    const sd = sessionDayContaining(utc("2026-04-22T00:00:00"), CONTINUOUS_24_7);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-21");
  });

  it("Wed 00:00:01 UTC → session-day Wed", () => {
    const sd = sessionDayContaining(utc("2026-04-22T00:00:01"), CONTINUOUS_24_7);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-22");
  });

  it("Sat 12:00 UTC → session-day Sat (24/7 has all 7 days)", () => {
    // 2026-04-25 is a Saturday.
    const sd = sessionDayContaining(utc("2026-04-25T12:00:00"), CONTINUOUS_24_7);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-25");
  });
});

describe("sessionDayContaining — NYSE RTH", () => {
  it("Tue 10:00 ET → session-day Tue", () => {
    const sd = sessionDayContaining(et("2026-04-21T10:00:00"), NYSE_RTH);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-21");
  });

  it("Tue 16:00 ET (RTH close, inclusive) → session-day Tue", () => {
    const sd = sessionDayContaining(et("2026-04-21T16:00:00"), NYSE_RTH);
    expect(sd).not.toBeNull();
    expect(sd!.label).toBe("2026-04-21");
  });

  it("Tue 09:30 ET (RTH open, exclusive) → null", () => {
    const sd = sessionDayContaining(et("2026-04-21T09:30:00"), NYSE_RTH);
    expect(sd).toBeNull();
  });

  it("Tue 17:00 ET (after RTH close) → null", () => {
    const sd = sessionDayContaining(et("2026-04-21T17:00:00"), NYSE_RTH);
    expect(sd).toBeNull();
  });
});
