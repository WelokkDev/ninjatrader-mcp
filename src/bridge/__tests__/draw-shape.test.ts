import { describe, it, expect } from "vitest";
import * as z4mini from "zod/v4-mini";
import { drawShapeSchema } from "../protocol.js";

// NT8 derives the third leg from the ratio, so callers supply exactly one of
// stop/target — both would be ambiguous, neither leaves nothing to derive from.
describe("drawShapeSchema riskreward", () => {
  const base = { kind: "riskreward" as const, entry: 25000, ratio: 3 };

  it("accepts the stop form", () => {
    const res = drawShapeSchema.safeParse({ ...base, stop: 24980 });
    expect(res.success).toBe(true);
  });

  it("accepts the target form", () => {
    const res = drawShapeSchema.safeParse({ ...base, target: 25060 });
    expect(res.success).toBe(true);
  });

  it("carries optional fromTs/toTs anchors", () => {
    const res = drawShapeSchema.safeParse({ ...base, stop: 24980, fromTs: 100, toTs: 200 });
    expect(res.success).toBe(true);
    expect(res.success && res.data).toMatchObject({ fromTs: 100, toTs: 200 });
  });

  it("rejects both legs at once", () => {
    const res = drawShapeSchema.safeParse({ ...base, stop: 24980, target: 25060 });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toMatch(/exactly one of stop or target/i);
  });

  it("rejects neither leg", () => {
    const res = drawShapeSchema.safeParse(base);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toMatch(/exactly one of stop or target/i);
  });

  // A zero-length risk leg collapses the drawing to one line at entry.
  it("rejects a stop equal to entry", () => {
    const res = drawShapeSchema.safeParse({ ...base, stop: 25000 });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toMatch(/must differ from entry/i);
  });

  it("rejects a target equal to entry", () => {
    const res = drawShapeSchema.safeParse({ ...base, target: 25000 });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toMatch(/must differ from entry/i);
  });

  it("rejects a non-positive ratio", () => {
    expect(drawShapeSchema.safeParse({ ...base, ratio: 0, stop: 24980 }).success).toBe(false);
    expect(drawShapeSchema.safeParse({ ...base, ratio: -1, stop: 24980 }).success).toBe(false);
  });

  it("accepts a short (stop above entry)", () => {
    const res = drawShapeSchema.safeParse({ ...base, stop: 25020 });
    expect(res.success).toBe(true);
  });
});

// Adding a refined member to the union must not disturb the plain ones.
describe("drawShapeSchema existing kinds", () => {
  it("still parses rectangle, hline, vline and text", () => {
    expect(drawShapeSchema.safeParse({ kind: "rectangle", proximal: 1, distal: 2 }).success).toBe(true);
    expect(drawShapeSchema.safeParse({ kind: "hline", price: 1 }).success).toBe(true);
    expect(drawShapeSchema.safeParse({ kind: "vline", ts: 1 }).success).toBe(true);
    expect(drawShapeSchema.safeParse({ kind: "text", ts: 1, price: 2, text: "x" }).success).toBe(true);
  });

  it("still rejects an unknown kind", () => {
    expect(drawShapeSchema.safeParse({ kind: "nope" }).success).toBe(false);
  });
});

// The MCP SDK converts tool schemas at registration via toJSONSchema WITHOUT
// unrepresentable:"any" — a refine that tripped it would crash server startup.
describe("drawShapeSchema JSON Schema conversion", () => {
  const toJson = () => z4mini.toJSONSchema(drawShapeSchema, { target: "draft-7", io: "input" }) as any;

  it("converts without throwing", () => {
    expect(toJson).not.toThrow();
  });

  it("emits riskreward with entry and ratio required, both legs optional", () => {
    const rr = toJson().oneOf.find((m: any) => m.properties?.kind?.const === "riskreward");
    expect(rr).toBeDefined();
    expect(rr.required.sort()).toEqual(["entry", "kind", "ratio"]);
    expect(rr.properties.stop).toBeDefined();
    expect(rr.properties.target).toBeDefined();
  });
});
