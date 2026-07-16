import { describe, it, expect } from "vitest";
import { parseMessage } from "../protocol.js";

const entry = {
  window: "Chart",
  symbol: "MNQ",
  instrument: "MNQ SEP26",
  timeframe: "5m",
  isActive: true,
  hasRenderer: true,
};

describe("parseMessage: open_charts_response", () => {
  it("accepts a valid response", () => {
    const res = parseMessage(
      JSON.stringify({ v: 1, type: "open_charts_response", id: "r1", charts: [entry], skippedWindows: 0 }),
    );
    expect(res).toEqual({
      ok: true,
      message: { v: 1, type: "open_charts_response", id: "r1", charts: [entry], skippedWindows: 0 },
    });
  });

  it("accepts an empty charts list", () => {
    const res = parseMessage(
      JSON.stringify({ v: 1, type: "open_charts_response", id: "r1", charts: [], skippedWindows: 0 }),
    );
    expect(res.ok).toBe(true);
  });

  it("defaults a missing skippedWindows to 0", () => {
    const res = parseMessage(
      JSON.stringify({ v: 1, type: "open_charts_response", id: "r1", charts: [entry] }),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "open_charts_response") {
      expect(res.message.skippedWindows).toBe(0);
    }
  });

  it("rejects a missing id", () => {
    const res = parseMessage(JSON.stringify({ v: 1, type: "open_charts_response", charts: [] }));
    expect(res).toEqual({ ok: false, reason: "open_charts_response: missing id" });
  });

  it("rejects a malformed chart entry", () => {
    const bad = { ...entry, isActive: "yes" };
    const res = parseMessage(
      JSON.stringify({ v: 1, type: "open_charts_response", id: "r1", charts: [bad] }),
    );
    expect(res).toEqual({ ok: false, reason: "open_charts_response: bad charts" });
  });
});
