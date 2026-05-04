import { describe, it, expect } from "vitest";
import {
  EXCHANGE_TZ,
  etDayStart,
  etDayEnd,
  formatExchangeTime,
  formatUtc,
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
