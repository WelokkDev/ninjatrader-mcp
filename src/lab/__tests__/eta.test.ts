import { describe, it, expect } from "vitest";
import { EtaCalibrator } from "../eta/calibrator.js";

describe("EtaCalibrator", () => {
  it("returns a cold fallback estimate when no samples exist", () => {
    const cal = new EtaCalibrator({ fallbackMsPerUnit: 400 });
    const est = cal.estimate("fake:observe", 100);
    expect(est.cold).toBe(true);
    expect(est.secs).toBeCloseTo(40); // 400ms * 100 / 1000
    expect(est.p50MsPerUnit).toBeNull();
  });

  it("uses the median (not mean) and exposes a p50..p90 band", () => {
    const cal = new EtaCalibrator();
    // Heavy-tailed: one huge outlier should NOT drag the estimate (median resists it).
    for (const ms of [100, 110, 120, 130, 12000]) cal.record("fake:observe", ms);
    const est = cal.estimate("fake:observe", 10);
    expect(est.cold).toBe(false);
    expect(est.p50MsPerUnit).toBe(120); // median of the 5
    expect(est.secs).toBeCloseTo((120 * 10) / 1000);
    // band upper (p90) reflects the spread and is >= the p50 point estimate
    expect(est.bandSecs![1]).toBeGreaterThanOrEqual(est.bandSecs![0]);
  });

  it("respects capacity (rolling window)", () => {
    const cal = new EtaCalibrator({ capacity: 3 });
    for (const ms of [1000, 1000, 10, 10, 10]) cal.record("k", ms);
    // only the last 3 (all 10) remain
    expect(cal.medianMsPerUnit("k")).toBe(10);
  });

  it("round-trips through JSON", () => {
    const cal = new EtaCalibrator();
    cal.record("k", 200);
    cal.record("k", 220);
    const restored = new EtaCalibrator();
    restored.loadJSON(cal.toJSON());
    expect(restored.medianMsPerUnit("k")).toBe(cal.medianMsPerUnit("k"));
  });
});
