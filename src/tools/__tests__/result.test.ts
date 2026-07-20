import { describe, it, expect } from "vitest";
import { errorResult, jsonResult, textResult } from "../result.js";

describe("result helpers", () => {
  it("textResult carries prose with no error flag", () => {
    const res = textResult("hello");
    expect(res.content[0].text).toBe("hello");
    expect(res.isError).toBeUndefined();
  });

  it("jsonResult JSON-encodes the payload with no error flag", () => {
    const res = jsonResult({ count: 2 });
    expect(JSON.parse(res.content[0].text)).toEqual({ count: 2 });
    expect(res.isError).toBeUndefined();
  });

  it("errorResult sets isError and wraps the message as JSON { error }", () => {
    const res = errorResult("it broke");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({ error: "it broke" });
  });

  it("errorResult merges extra envelope fields, error winning collisions", () => {
    const res = errorResult("boom", { ok: false, error: "shadowed" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: false, error: "boom" });
  });
});
