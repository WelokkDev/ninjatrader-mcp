import { describe, it, expect } from "vitest";
import { pairCheck } from "../src/private/waw/pair-check.js";
import { defaultDetectionConfig } from "../src/private/waw/detection-config.js";
import type { Candle } from "../src/private/waw/types.js";

function bar(o: number, h: number, l: number, c: number, ts = 0): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 0 };
}

const dflt = defaultDetectionConfig;

describe("pairCheck — detection rule", () => {
  it("case 1: clean demand pair", () => {
    const c1 = bar(100, 100, 95, 95);
    const c2 = bar(97, 99, 96, 99);
    const r = pairCheck(c1, c2, dflt);
    expect(r.match).toBe(true);
    if (r.match) {
      expect(r.zoneType).toBe("demand");
      expect(r.proximal).toBe(97);
      expect(r.distal).toBe(96);
      expect(r.detectionMeta.wickHeight).toBe(1);
      expect(r.detectionMeta.c1BodyHeight).toBe(5);
      expect(r.detectionMeta.coverageRatio).toBeCloseTo(0.2);
    }
  });

  it("case 2: clean supply pair", () => {
    const c1 = bar(95, 100, 95, 100);
    const c2 = bar(99, 99.5, 97, 97);
    const r = pairCheck(c1, c2, dflt);
    expect(r.match).toBe(true);
    if (r.match) {
      expect(r.zoneType).toBe("supply");
      expect(r.proximal).toBe(99);
      expect(r.distal).toBe(99.5);
      expect(r.detectionMeta.wickHeight).toBeCloseTo(0.5);
      expect(r.detectionMeta.c1BodyHeight).toBe(5);
    }
  });

  it("case 3: lower wick pokes below c1 body — demand fails", () => {
    const c1 = bar(100, 100, 95, 95);
    const c2 = bar(97, 99, 94, 99);
    expect(pairCheck(c1, c2, dflt).match).toBe(false);
  });

  it("case 4: c2.open above c1 body high — demand fails", () => {
    const c1 = bar(100, 100, 95, 95);
    const c2 = bar(101, 103, 100.5, 103);
    expect(pairCheck(c1, c2, dflt).match).toBe(false);
  });

  it("case 5: zero-length wick — fails", () => {
    const c1 = bar(100, 100, 95, 95);
    const c2 = bar(97, 99, 97, 99);
    expect(pairCheck(c1, c2, dflt).match).toBe(false);
  });

  it("case 6: doji c2 — fails by default", () => {
    const c1 = bar(100, 100, 95, 95);
    const c2 = bar(97, 98, 96, 97);
    expect(pairCheck(c1, c2, dflt).match).toBe(false);
  });

  it("case 7: doji c1 — fails (no wall to anchor against)", () => {
    const c1 = bar(100, 100, 100, 100);
    const c2 = bar(97, 99, 96, 99);
    expect(pairCheck(c1, c2, dflt).match).toBe(false);
  });

  describe("case 8: coverage ratio threshold", () => {
    const c1 = bar(100, 100, 95, 95);

    it("fails when wick is below threshold", () => {
      const c2 = bar(97, 99, 96, 99);
      const r = pairCheck(c1, c2, {
        ...dflt,
        minWickCoverageOfPriorBody: 0.5,
      });
      expect(r.match).toBe(false);
    });

    it("passes when wick meets threshold exactly", () => {
      const c2 = bar(100, 101, 97.5, 101);
      const r = pairCheck(c1, c2, {
        ...dflt,
        minWickCoverageOfPriorBody: 0.5,
      });
      expect(r.match).toBe(true);
      if (r.match) {
        expect(r.zoneType).toBe("demand");
        expect(r.detectionMeta.coverageRatio).toBeCloseTo(0.5);
      }
    });
  });

  describe("case 9: c2's color decides which wick is checked", () => {
    it("bearish c2 with a lower wick is not a demand pair", () => {
      const c1 = bar(100, 100, 95, 95);
      // bearish (close 97 < open 99); lower wick [96, 97] sits inside c1 body.
      // The demand branch never runs because c2 is bearish — and the supply
      // branch fails because the upper wick [99, 99] has zero height.
      const c2 = bar(99, 99, 96, 97);
      expect(pairCheck(c1, c2, dflt).match).toBe(false);
    });

    it("bullish c2 with an upper wick is not a supply pair", () => {
      const c1 = bar(100, 100, 95, 95);
      // bullish (close 99 > open 97); upper wick [99, 99.5] sits inside c1 body.
      // Supply branch never runs because c2 is bullish — and the demand
      // branch fails because the lower wick [97, 97] has zero height.
      const c2 = bar(97, 99.5, 97, 99);
      expect(pairCheck(c1, c2, dflt).match).toBe(false);
    });
  });
});
