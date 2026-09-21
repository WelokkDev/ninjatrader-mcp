import { describe, it, expect } from "vitest";
import { capsError, PRE_CAPS_ADDON_CAPS } from "../caps.js";

describe("capsError", () => {
  it("passes an op the AddOn advertises", () => {
    expect(capsError("place_oco", ["place_order", "place_oco"])).toBeNull();
  });

  it("names the fix for an op it does not", () => {
    const msg = capsError("set_indicator_params", ["place_order"]);
    expect(msg).toContain("does not support set_indicator_params");
    expect(msg).toContain("recompile");
  });

  it("treats absent caps as the pre-caps AddOn, not as a wildcard", () => {
    expect(capsError("place_order", null)).toBeNull();
    expect(capsError("flatten", null)).not.toBeNull();
    expect(PRE_CAPS_ADDON_CAPS).toEqual(["place_order"]);
  });
});
