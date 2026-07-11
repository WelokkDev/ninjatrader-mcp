import { describe, it, expect } from "vitest";
import { drawTargetWarning } from "../draw-target.js";

describe("drawTargetWarning", () => {
  it("returns undefined when the symbol has an attached chart", () => {
    expect(drawTargetWarning("NQ", ["ES", "NQ"])).toBeUndefined();
  });

  it("warns and names the symbol + attached charts when absent", () => {
    const w = drawTargetWarning("CL", ["ES", "NQ"]);
    expect(w).toBeDefined();
    expect(w).toMatch(/CL/);
    expect(w).toMatch(/ES, NQ/);
  });

  it("reports 'none' when no charts are attached", () => {
    expect(drawTargetWarning("NQ", [])).toMatch(/none/);
  });
});
