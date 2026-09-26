import { describe, it, expect } from "vitest";
import { createClearZonesHandler } from "../src/tools/clear-zones.js";
import type { OutboundMessage } from "../src/bridge/protocol.js";

function captureSend() {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    send: (m: OutboundMessage) => {
      sent.push(m);
      return true;
    },
  };
}

describe("clear_zones handler", () => {
  it("dispatches with symbol + ids", async () => {
    const cap = captureSend();
    const handler = createClearZonesHandler({
      isConnected: () => true,
      send: cap.send,
    });

    await handler({ symbol: "NQ", ids: ["a", "b"] });

    expect(cap.sent[0]).toEqual({
      v: 1,
      type: "clear_zones",
      symbol: "NQ",
      ids: ["a", "b"],
    });
  });

  it("all:true with an empty ids array sends the clear-everything form", async () => {
    const cap = captureSend();
    const handler = createClearZonesHandler({
      isConnected: () => true,
      send: cap.send,
    });

    await handler({ symbol: "NQ", ids: [], all: true });

    expect(cap.sent[0]).toEqual({ v: 1, type: "clear_zones", symbol: "NQ" });
    expect(cap.sent[0]).not.toHaveProperty("ids");
  });

  it("all:true without a symbol is the clear-all-charts form", async () => {
    const cap = captureSend();
    const handler = createClearZonesHandler({
      isConnected: () => true,
      send: cap.send,
    });

    await handler({ all: true });

    expect(cap.sent[0]).toEqual({ v: 1, type: "clear_zones" });
    expect(cap.sent[0]).not.toHaveProperty("symbol");
  });

  it("with neither ids nor all, a caller that drew nothing gets a refusal and nothing is sent", async () => {
    const cap = captureSend();
    const handler = createClearZonesHandler({
      isConnected: () => true,
      send: cap.send,
    });

    const res = await handler({});

    expect(res.isError).toBe(true);
    expect(cap.sent).toHaveLength(0);
  });

  it("does not call send when bridge is disconnected", async () => {
    const cap = captureSend();
    const handler = createClearZonesHandler({
      isConnected: () => false,
      send: cap.send,
    });

    const result = await handler({ symbol: "NQ" });
    expect(cap.sent).toHaveLength(0);
    expect(result.content[0].text).toMatch(/NinjaTrader is not connected/);
  });
});
