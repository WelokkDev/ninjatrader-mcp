import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { drawingConfigSchema } from "../drawing-config.js";

describe("drawing.config.json", () => {
  it("the committed sample validates against the schema", () => {
    const raw = readFileSync(path.join(process.cwd(), "drawing.config.json"), "utf8");
    const parsed = drawingConfigSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
  });

  it("rejects a role missing a color", () => {
    const bad = { roles: { entry: { shape: "rectangle" } }, views: {} };
    expect(drawingConfigSchema.safeParse(bad).success).toBe(false);
  });
});
