import { describe, it, expect } from "vitest";
import { getCandleDirection } from "../src/core/candle.js";
import type { Candle } from "../src/core/types.js";

function bar(open: number, close: number): Candle {
  return {
    timestamp: 0,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 0,
  };
}

describe("getCandleDirection", () => {
  it("returns bullish when close > open", () => {
    expect(getCandleDirection(bar(100, 105))).toBe("bullish");
  });

  it("returns bearish when close < open", () => {
    expect(getCandleDirection(bar(105, 100))).toBe("bearish");
  });

  it("returns doji when close === open", () => {
    expect(getCandleDirection(bar(100, 100))).toBe("doji");
  });
});
