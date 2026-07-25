import { describe, it, expect } from "vitest";
import { parseMessage } from "../protocol.js";

const riskReward = {
  window: "Chart",
  symbol: "MNQ",
  timeframe: "5m",
  tag: "RiskReward@1",
  toolType: "RiskReward",
  isUserDrawn: true,
  isVisible: true,
  anchors: [
    { price: 20000, ts: 1_700_000_000 },
    { price: 19950, ts: 1_700_000_000 },
    { price: 20150, ts: 1_700_003_600 },
  ],
  riskReward: {
    entry: 20000,
    stop: 19950,
    target: 20150,
    direction: "long",
    riskPoints: 50,
    rewardPoints: 150,
    computedRatio: 3,
    ratio: 3,
  },
};

// A non-RR tool: no riskReward block, and an anchor with no ts (unconvertible).
const line = {
  window: "Chart",
  symbol: "MNQ",
  timeframe: "5m",
  tag: "Ray@2",
  toolType: "Ray",
  isUserDrawn: false,
  isVisible: true,
  anchors: [{ price: 20010 }],
};

function msg(drawings: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, type: "drawings_response", id: "r1", drawings, ...extra });
}

describe("parseMessage: drawings_response", () => {
  it("accepts a valid response with a RiskReward and a plain tool", () => {
    const res = parseMessage(msg([riskReward, line], { skippedWindows: 0 }));
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "drawings_response") {
      expect(res.message.drawings).toHaveLength(2);
      expect(res.message.drawings[0].riskReward?.direction).toBe("long");
      expect(res.message.drawings[1].riskReward).toBeUndefined();
    }
  });

  it("accepts an empty drawings list", () => {
    expect(parseMessage(msg([])).ok).toBe(true);
  });

  it("defaults a missing skippedWindows to 0", () => {
    const res = parseMessage(msg([line]));
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "drawings_response") {
      expect(res.message.skippedWindows).toBe(0);
    }
  });

  it("keeps an anchor ts optional", () => {
    const res = parseMessage(msg([line]));
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "drawings_response") {
      expect(res.message.drawings[0].anchors[0].ts).toBeUndefined();
      expect(res.message.drawings[0].anchors[0].price).toBe(20010);
    }
  });

  it("rejects a missing id", () => {
    const res = parseMessage(JSON.stringify({ v: 1, type: "drawings_response", drawings: [] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("drawings_response: id");
  });

  it("rejects a non-numeric anchor price", () => {
    const bad = { ...line, anchors: [{ price: "20010" }] };
    const res = parseMessage(msg([bad]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("drawings");
  });

  it("rejects an out-of-range riskReward.direction", () => {
    const bad = { ...riskReward, riskReward: { ...riskReward.riskReward, direction: "sideways" } };
    const res = parseMessage(msg([bad]));
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong-typed skippedWindows instead of coercing it", () => {
    expect(parseMessage(msg([], { skippedWindows: "3" })).ok).toBe(false);
  });
});
