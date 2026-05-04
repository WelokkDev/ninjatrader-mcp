import { describe, it, expect } from "vitest";
import { aggregateCandles } from "../src/core/aggregator.js";
import type { Candle } from "../src/core/types.js";

// Build a 15m candle at the given ET wall-clock; volume = open for easy assertion.
function bar(etISO: string, ohlc: [number, number, number, number]): Candle {
  // ET offset in May 2026 = -04:00 (EDT)
  const ts = Math.floor(Date.parse(`${etISO}-04:00`) / 1000);
  return {
    timestamp: ts,
    open: ohlc[0],
    high: ohlc[1],
    low: ohlc[2],
    close: ohlc[3],
    volume: ohlc[0],
  };
}

describe("aggregateCandles", () => {
  it("returns a copy when target is 15m", () => {
    const input: Candle[] = [bar("2026-05-01T09:30", [1, 2, 0.5, 1.5])];
    const out = aggregateCandles(input, "15m");
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("aggregates two 15m bars into one 30m bar (clock-aligned)", () => {
    const input: Candle[] = [
      bar("2026-05-01T09:30", [100, 110, 95, 105]),
      bar("2026-05-01T09:45", [105, 120, 100, 115]),
    ];
    const out = aggregateCandles(input, "30m");
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.open).toBe(100);
    expect(c.high).toBe(120);
    expect(c.low).toBe(95);
    expect(c.close).toBe(115);
    expect(c.volume).toBe(205); // 100 + 105
  });

  it("aggregates four 15m bars into one 1h bar", () => {
    const input: Candle[] = [
      bar("2026-05-01T10:00", [100, 110, 95, 105]),
      bar("2026-05-01T10:15", [105, 115, 100, 110]),
      bar("2026-05-01T10:30", [110, 125, 108, 120]),
      bar("2026-05-01T10:45", [120, 130, 115, 128]),
    ];
    const out = aggregateCandles(input, "1h");
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(100);
    expect(out[0].high).toBe(130);
    expect(out[0].low).toBe(95);
    expect(out[0].close).toBe(128);
  });

  it("never aggregates across day boundaries", () => {
    const input: Candle[] = [
      bar("2026-05-01T15:30", [100, 105, 99, 102]),
      bar("2026-05-01T15:45", [102, 108, 100, 107]),
      bar("2026-05-02T09:30", [200, 210, 195, 205]),
      bar("2026-05-02T09:45", [205, 220, 200, 215]),
    ];
    const out = aggregateCandles(input, "30m");
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(107);
    expect(out[1].open).toBe(200);
    expect(out[1].close).toBe(215);
  });

  it("4h is session-aligned (9:30 ET, 13:30 ET buckets)", () => {
    // Bars from 9:30 to 13:15 should land in the 9:30 bucket; bars from 13:30
    // onward should land in the 13:30 bucket.
    const input: Candle[] = [
      bar("2026-05-01T09:30", [100, 100, 100, 100]),
      bar("2026-05-01T13:15", [101, 101, 101, 101]),
      bar("2026-05-01T13:30", [200, 200, 200, 200]),
      bar("2026-05-01T15:45", [201, 201, 201, 201]),
    ];
    const out = aggregateCandles(input, "4h");
    expect(out).toHaveLength(2);
    expect(out[0].open).toBe(100);
    expect(out[0].close).toBe(101);
    expect(out[1].open).toBe(200);
    expect(out[1].close).toBe(201);
  });

  it("output is sorted by timestamp ascending", () => {
    const input: Candle[] = [
      bar("2026-05-02T09:30", [200, 210, 195, 205]),
      bar("2026-05-02T09:45", [205, 215, 200, 210]),
      bar("2026-05-01T09:30", [100, 110, 95, 105]),
      bar("2026-05-01T09:45", [105, 120, 100, 115]),
    ];
    const out = aggregateCandles(input, "30m");
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBeLessThan(out[1].timestamp);
  });
});
