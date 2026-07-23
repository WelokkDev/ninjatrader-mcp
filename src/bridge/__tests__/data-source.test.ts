import { describe, it, expect } from "vitest";
import { SIMULATED_DATA_FEED, isSimulatedFeed } from "../data-source.js";

describe("isSimulatedFeed", () => {
  it("is true for the exact NT8 sim-feed name", () => {
    expect(isSimulatedFeed(SIMULATED_DATA_FEED)).toBe(true);
    expect(isSimulatedFeed("Simulated Data Feed")).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(isSimulatedFeed("simulated data feed")).toBe(true);
    expect(isSimulatedFeed("  SIMULATED DATA FEED  ")).toBe(true);
  });

  it("is false for real provider names", () => {
    expect(isSimulatedFeed("Rithmic")).toBe(false);
    expect(isSimulatedFeed("Kinetick")).toBe(false);
    expect(isSimulatedFeed("Playback Connection")).toBe(false);
  });

  it("treats absent / empty provenance as NOT sim (unknown is cached as real)", () => {
    expect(isSimulatedFeed(undefined)).toBe(false);
    expect(isSimulatedFeed(null)).toBe(false);
    expect(isSimulatedFeed("")).toBe(false);
    expect(isSimulatedFeed("   ")).toBe(false);
  });
});
