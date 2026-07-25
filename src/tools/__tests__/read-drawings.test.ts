import { describe, it, expect } from "vitest";
import { createGetDrawingsHandler } from "../read-drawings.js";
import type { InboundMessage } from "../../bridge/protocol.js";

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

const line = {
  window: "Chart",
  symbol: "MNQ",
  timeframe: "5m",
  tag: "Ray@2",
  toolType: "Ray",
  isUserDrawn: false,
  isVisible: true,
  anchors: [{ price: 20010 }], // no ts
};

function response(
  overrides: Partial<{ drawings: unknown[]; skippedWindows: number }> = {},
): InboundMessage {
  return {
    v: 1,
    id: "r1",
    type: "drawings_response",
    drawings: [riskReward, line],
    skippedWindows: 0,
    ...overrides,
  } as InboundMessage;
}

describe("get_drawings handler", () => {
  it("reports disconnection without calling request", async () => {
    let called = false;
    const handler = createGetDrawingsHandler({
      isConnected: () => false,
      request: async () => {
        called = true;
        return response();
      },
    });
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain("not connected");
    expect(called).toBe(false);
  });

  it("returns the drawings as JSON with a riskRewardCount", async () => {
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async () => response(),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    expect(parsed.drawingCount).toBe(2);
    expect(parsed.riskRewardCount).toBe(1);
    expect(parsed.drawings[0].riskReward.direction).toBe("long");
    expect(parsed.skippedWindows).toBeUndefined();
  });

  it("adds a human-readable time next to anchors that carry a ts", async () => {
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async () => response(),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    // RiskReward anchors carry a ts → a formatted `time` is added; price is kept.
    expect(typeof parsed.drawings[0].anchors[0].time).toBe("string");
    expect(parsed.drawings[0].anchors[0].price).toBe(20000);
    // The plain tool's anchor has no ts → no `time` field is invented.
    expect(parsed.drawings[1].anchors[0].time).toBeUndefined();
  });

  it("omits riskRewardCount when there are no R:R tools", async () => {
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async () => response({ drawings: [line] }),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    expect(parsed.drawingCount).toBe(1);
    expect(parsed.riskRewardCount).toBeUndefined();
  });

  it("surfaces skippedWindows when non-zero", async () => {
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async () => response({ skippedWindows: 2 }),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    expect(parsed.skippedWindows).toBe(2);
  });

  it("passes filters through to the request payload", async () => {
    let captured: { type: string; payload: Record<string, unknown> } | undefined;
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async (type, payload) => {
        captured = { type, payload };
        return response();
      },
    });
    await handler({ symbol: "MNQ", toolType: "RiskReward", userDrawnOnly: true });
    expect(captured?.type).toBe("request_drawings");
    expect(captured?.payload).toEqual({ symbol: "MNQ", toolType: "RiskReward", userDrawnOnly: true });
  });

  it("sends an empty payload when no filters are given", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async (_type, payload) => {
        captured = payload;
        return response();
      },
    });
    await handler({});
    expect(captured).toEqual({});
  });

  it("rewrites a timeout into the stale-addon hint", async () => {
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("Request request_drawings (x) timed out after 5000ms");
      },
    });
    const text = (await handler({})).content[0].text;
    expect(text).toContain("recompile");
  });

  it("passes through a bridge error message", async () => {
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("window enumeration failed: boom");
      },
    });
    expect((await handler({})).content[0].text).toContain("window enumeration failed: boom");
  });

  it("rejects an unexpected response type", async () => {
    const handler = createGetDrawingsHandler({
      isConnected: () => true,
      request: async () => ({ v: 1, type: "heartbeat" }) as InboundMessage,
    });
    expect((await handler({})).content[0].text).toContain("unexpected response type");
  });
});
