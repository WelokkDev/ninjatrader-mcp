import { describe, it, expect } from "vitest";
import {
  EXCHANGE_TZ,
  etDayStart,
  etDayEnd,
  formatExchangeTime,
  formatUtc,
  formatLocalISO,
  wallClockHHMM,
  wallClockToUnix,
} from "../src/core/time.js";

// These tests pin down the canonical timezone convention used across the
// codebase. If they fail, the renderer is going to draw zones at the wrong
// place — fix the convention drift, do not "update the expected value".

describe("EXCHANGE_TZ", () => {
  it("is America/New_York (the canonical project tz)", () => {
    expect(EXCHANGE_TZ).toBe("America/New_York");
  });
});

describe("etDayStart / etDayEnd in EDT (May 2026, UTC-4)", () => {
  it("etDayStart for 2026-04-30 maps to 2026-04-30T04:00:00Z", () => {
    const ts = etDayStart("2026-04-30");
    expect(ts).toBe(1777521600);
    expect(formatUtc(ts)).toBe("2026-04-30T04:00:00.000Z");
    expect(formatExchangeTime(ts)).toBe("2026-04-30 00:00:00");
  });

  it("etDayEnd for 2026-05-01 maps to 2026-05-02T03:59:59Z (the original bug fix)", () => {
    const ts = etDayEnd("2026-05-01");
    expect(ts).toBe(1777694399);
    expect(formatUtc(ts)).toBe("2026-05-02T03:59:59.000Z");
    expect(formatExchangeTime(ts)).toBe("2026-05-01 23:59:59");
  });

  it("etDayStart and etDayEnd for the same day are 86399 seconds apart", () => {
    expect(etDayEnd("2026-04-30") - etDayStart("2026-04-30")).toBe(86399);
  });
});

describe("etDayStart / etDayEnd across DST boundaries", () => {
  it("EST (winter, UTC-5) — 2026-01-15 day-start is at 05:00 UTC", () => {
    const ts = etDayStart("2026-01-15");
    expect(formatUtc(ts)).toBe("2026-01-15T05:00:00.000Z");
    expect(formatExchangeTime(ts)).toBe("2026-01-15 00:00:00");
  });

  it("EDT (summer, UTC-4) — 2026-07-15 day-start is at 04:00 UTC", () => {
    const ts = etDayStart("2026-07-15");
    expect(formatUtc(ts)).toBe("2026-07-15T04:00:00.000Z");
    expect(formatExchangeTime(ts)).toBe("2026-07-15 00:00:00");
  });
});

describe("formatExchangeTime / formatUtc round-trips", () => {
  it("a known unix value renders consistent UTC and ET strings", () => {
    // 2026-05-01 16:00:00 UTC = 2026-05-01 12:00:00 EDT (RTH-ish midday)
    const ts = 1777651200;
    expect(formatUtc(ts)).toBe("2026-05-01T16:00:00.000Z");
    expect(formatExchangeTime(ts)).toBe("2026-05-01 12:00:00");
  });
});

describe("formatLocalISO — ISO-8601 with explicit offset", () => {
  it("EST (winter, UTC-5): 2026-01-29T15:00:00Z renders as 2026-01-29T10:00:00-05:00", () => {
    const ts = Math.floor(Date.UTC(2026, 0, 29, 15, 0, 0) / 1000);
    expect(formatLocalISO(ts, EXCHANGE_TZ)).toBe("2026-01-29T10:00:00-05:00");
  });

  it("EDT (summer, UTC-4): 2026-07-15T14:00:00Z renders as 2026-07-15T10:00:00-04:00", () => {
    const ts = Math.floor(Date.UTC(2026, 6, 15, 14, 0, 0) / 1000);
    expect(formatLocalISO(ts, EXCHANGE_TZ)).toBe("2026-07-15T10:00:00-04:00");
  });

  it("UTC tz renders with +00:00 offset", () => {
    const ts = Math.floor(Date.UTC(2026, 0, 29, 15, 0, 0) / 1000);
    expect(formatLocalISO(ts, "UTC")).toBe("2026-01-29T15:00:00+00:00");
  });

  it("London during BST: 2026-07-15T14:00:00Z renders as 2026-07-15T15:00:00+01:00", () => {
    const ts = Math.floor(Date.UTC(2026, 6, 15, 14, 0, 0) / 1000);
    expect(formatLocalISO(ts, "Europe/London")).toBe(
      "2026-07-15T15:00:00+01:00",
    );
  });

  it("round-trip: new Date(formatLocalISO(t, tz)) preserves the original unix instant", () => {
    const cases = [
      Math.floor(Date.UTC(2026, 0, 29, 15, 0, 0) / 1000), // EST
      Math.floor(Date.UTC(2026, 6, 15, 14, 0, 0) / 1000), // EDT
      Math.floor(Date.UTC(2026, 2, 8, 7, 0, 0) / 1000), // spring-forward day
      Math.floor(Date.UTC(2026, 10, 1, 6, 0, 0) / 1000), // fall-back day
    ];
    for (const ts of cases) {
      const iso = formatLocalISO(ts, EXCHANGE_TZ);
      const parsed = Math.floor(new Date(iso).getTime() / 1000);
      expect(parsed).toBe(ts);
    }
  });
});

describe("wallClockHHMM", () => {
  it("renders ET wall clock under EST and EDT", () => {
    // 2026-02-16 13:00 EST = 18:00 UTC; 2026-04-03 09:15 EDT = 13:15 UTC.
    expect(wallClockHHMM(Math.floor(Date.UTC(2026, 1, 16, 18, 0, 0) / 1000), "America/New_York")).toBe("13:00");
    expect(wallClockHHMM(Math.floor(Date.UTC(2026, 3, 3, 13, 15, 0) / 1000), "America/New_York")).toBe("09:15");
  });
});

// DST transition days: ET springs forward 2026-03-08 / 2025-03-09 and
// falls back 2026-11-01 / 2025-11-02 (transitions at 02:00 local).
// Midnight on those dates is the regression trap. Expected values are
// explicit UTC constants — never computed with a converter under test.
describe("etDayStart / etDayEnd on DST transition days", () => {
  it("spring forward 2026-03-08: day-start is 05:00Z (EST midnight), day-end 03:59:59Z next day", () => {
    const start = etDayStart("2026-03-08");
    expect(start).toBe(1772946000);
    expect(formatUtc(start)).toBe("2026-03-08T05:00:00.000Z");
    expect(formatExchangeTime(start)).toBe("2026-03-08 00:00:00");
    const end = etDayEnd("2026-03-08");
    expect(end).toBe(1773028799);
    expect(formatUtc(end)).toBe("2026-03-09T03:59:59.000Z");
    expect(formatExchangeTime(end)).toBe("2026-03-08 23:59:59");
    // 23-hour day: one hour shorter than the usual 86399-second span.
    expect(end - start).toBe(86399 - 3600);
  });

  it("fall back 2026-11-01: day-start is 04:00Z (EDT midnight), day-end 04:59:59Z next day", () => {
    const start = etDayStart("2026-11-01");
    expect(start).toBe(1793505600);
    expect(formatUtc(start)).toBe("2026-11-01T04:00:00.000Z");
    expect(formatExchangeTime(start)).toBe("2026-11-01 00:00:00");
    const end = etDayEnd("2026-11-01");
    expect(end).toBe(1793595599);
    expect(formatUtc(end)).toBe("2026-11-02T04:59:59.000Z");
    expect(formatExchangeTime(end)).toBe("2026-11-01 23:59:59");
    // 25-hour day.
    expect(end - start).toBe(86399 + 3600);
  });

  it("2025 transition days pin the same convention", () => {
    expect(formatUtc(etDayStart("2025-03-09"))).toBe("2025-03-09T05:00:00.000Z");
    expect(formatUtc(etDayEnd("2025-03-09"))).toBe("2025-03-10T03:59:59.000Z");
    expect(formatUtc(etDayStart("2025-11-02"))).toBe("2025-11-02T04:00:00.000Z");
    expect(formatUtc(etDayEnd("2025-11-02"))).toBe("2025-11-03T04:59:59.000Z");
  });
});

describe("wallClockToUnix DST semantics (America/New_York)", () => {
  const et = (y: number, mo: number, d: number, h: number, mi = 0) =>
    wallClockToUnix(y, mo, d, h, mi, 0, EXCHANGE_TZ);
  const utc = (y: number, mo: number, d: number, h: number, mi = 0) =>
    Math.floor(Date.UTC(y, mo - 1, d, h, mi, 0) / 1000);

  it("spring-forward day 2026-03-08: pre-transition wall clocks use EST", () => {
    expect(et(2026, 3, 8, 0, 0)).toBe(utc(2026, 3, 8, 5, 0)); // midnight EST
    expect(et(2026, 3, 8, 1, 30)).toBe(utc(2026, 3, 8, 6, 30)); // 01:30 EST
  });

  it("spring-forward gap (02:00-02:59 does not exist): maps forward by the gap width", () => {
    expect(et(2026, 3, 8, 2, 0)).toBe(utc(2026, 3, 8, 7, 0)); // → 03:00 EDT
    expect(et(2026, 3, 8, 2, 30)).toBe(utc(2026, 3, 8, 7, 30)); // → 03:30 EDT
  });

  it("spring-forward day: post-transition wall clocks use EDT", () => {
    expect(et(2026, 3, 8, 3, 0)).toBe(utc(2026, 3, 8, 7, 0)); // 03:00 EDT
    expect(et(2026, 3, 8, 18, 0)).toBe(utc(2026, 3, 8, 22, 0)); // CME Sunday open
  });

  it("fall-back day 2026-11-01: ambiguous 01:xx resolves to the first (EDT) occurrence", () => {
    expect(et(2026, 11, 1, 0, 30)).toBe(utc(2026, 11, 1, 4, 30)); // 00:30 EDT
    expect(et(2026, 11, 1, 1, 30)).toBe(utc(2026, 11, 1, 5, 30)); // 01:30 EDT, not 06:30Z EST
  });

  it("fall-back day: post-transition wall clocks use EST", () => {
    expect(et(2026, 11, 1, 2, 0)).toBe(utc(2026, 11, 1, 7, 0)); // 02:00 EST
    expect(et(2026, 11, 1, 18, 0)).toBe(utc(2026, 11, 1, 23, 0)); // CME Sunday open
  });

  it("UTC is the identity mapping", () => {
    expect(wallClockToUnix(2026, 7, 15, 12, 34, 56, "UTC")).toBe(
      Math.floor(Date.UTC(2026, 6, 15, 12, 34, 56) / 1000),
    );
  });
});
