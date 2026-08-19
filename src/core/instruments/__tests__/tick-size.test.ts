import { describe, it, expect } from "vitest";
import {
  INSTRUMENTS,
  getInstrument,
  getPointValue,
  getTickSize,
} from "../tick-size.js";
import { SUPPORTED_SYMBOLS } from "../../constants.js";

// Worth testing rather than eyeballing: an off-by-a-factor pointValue throws
// nowhere and just reports wrong dollars, and a symbol the session registry
// supports but this one forgets throws mid-run on the first price conversion.

describe("instrument registry", () => {
  it("covers exactly the symbols the session registry supports", () => {
    // Both directions — an entry with no session is a symbol nothing else can
    // read bars for.
    expect(Object.keys(INSTRUMENTS).sort()).toEqual([...SUPPORTED_SYMBOLS].sort());
  });

  it("carries the exchange-listed tick sizes", () => {
    // 0.25 is right for four of the ten; the other six are why a hardcoded
    // default is a defect.
    expect(getTickSize("ES")).toBe(0.25);
    expect(getTickSize("NQ")).toBe(0.25);
    expect(getTickSize("MES")).toBe(0.25);
    expect(getTickSize("MNQ")).toBe(0.25);
    expect(getTickSize("YM")).toBe(1.0);
    expect(getTickSize("MYM")).toBe(1.0);
    expect(getTickSize("RTY")).toBe(0.1);
    expect(getTickSize("M2K")).toBe(0.1);
    expect(getTickSize("CL")).toBe(0.01);
    expect(getTickSize("GC")).toBe(0.1);
  });

  it("carries the exchange-listed point values, micros at their divisor", () => {
    expect(getPointValue("ES")).toBe(50);
    expect(getPointValue("NQ")).toBe(20);
    expect(getPointValue("YM")).toBe(5);
    expect(getPointValue("RTY")).toBe(50);
    expect(getPointValue("CL")).toBe(1000);
    expect(getPointValue("GC")).toBe(100);
    // 1/10 of the parent — the relation that catches a transposed digit.
    expect(getPointValue("MES")).toBe(getPointValue("ES") / 10);
    expect(getPointValue("MNQ")).toBe(getPointValue("NQ") / 10);
    expect(getPointValue("MYM")).toBe(getPointValue("YM") / 10);
    expect(getPointValue("M2K")).toBe(getPointValue("RTY") / 10);
  });

  it("gives every symbol a whole-cent tick value", () => {
    // The private money core is integer cents and refuses a fractional-cent
    // tick, which nothing catches until a run starts.
    for (const symbol of Object.keys(INSTRUMENTS)) {
      const { tickSize, pointValue } = getInstrument(symbol);
      const cents = tickSize * pointValue * 100;
      expect(Math.abs(cents - Math.round(cents)), `${symbol} tick value`).toBeLessThan(1e-6);
      expect(cents, `${symbol} tick value`).toBeGreaterThan(0);
    }
  });

  it("returns both numbers together", () => {
    expect(getInstrument("MNQ")).toEqual({ tickSize: 0.25, pointValue: 2 });
  });

  it("throws on an unknown symbol, naming where to add it", () => {
    // Never fall back to a plausible guess.
    expect(() => getInstrument("SPY")).toThrow(/src\/core\/instruments\/tick-size\.ts/);
    expect(() => getTickSize("")).toThrow();
    expect(() => getPointValue("nq")).toThrow(); // case-sensitive, like the session registry
  });
});
