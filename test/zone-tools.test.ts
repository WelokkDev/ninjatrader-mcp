import { describe, it, expect } from "vitest";
import { createDrawZoneHandler } from "../src/tools/draw-zone.js";
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

describe("draw_zone handler", () => {
  it("dispatches a fully-specified draw_zone message", async () => {
    const cap = captureSend();
    const handler = createDrawZoneHandler({
      isConnected: () => true,
      send: cap.send,
    });

    const result = await handler({
      id: "z1",
      symbol: "NQ",
      proximal: 20100,
      distal: 20050,
      fromTs: 1700000000,
      toTs: 1700100000,
    });

    expect(cap.sent).toHaveLength(1);
    expect(cap.sent[0]).toEqual({
      v: 1,
      type: "draw_zone",
      id: "z1",
      symbol: "NQ",
      proximal: 20100,
      distal: 20050,
      fromTs: 1700000000,
      toTs: 1700100000,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.dispatched).toBe(true);
  });

  it("omits fromTs/toTs from the wire when not provided", async () => {
    const cap = captureSend();
    const handler = createDrawZoneHandler({
      isConnected: () => true,
      send: cap.send,
    });

    await handler({ id: "z2", symbol: "ES", proximal: 5000, distal: 4990 });

    expect(cap.sent[0]).not.toHaveProperty("fromTs");
    expect(cap.sent[0]).not.toHaveProperty("toTs");
  });

  it("does not call send when bridge is disconnected", async () => {
    const cap = captureSend();
    const handler = createDrawZoneHandler({
      isConnected: () => false,
      send: cap.send,
    });

    const result = await handler({
      id: "z3",
      symbol: "NQ",
      proximal: 100,
      distal: 90,
    });

    expect(cap.sent).toHaveLength(0);
    expect(result.content[0].text).toMatch(/NinjaTrader is not connected/);
  });
});

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

  it("omits ids when empty array is passed", async () => {
    const cap = captureSend();
    const handler = createClearZonesHandler({
      isConnected: () => true,
      send: cap.send,
    });

    await handler({ symbol: "NQ", ids: [] });

    expect(cap.sent[0]).toEqual({ v: 1, type: "clear_zones", symbol: "NQ" });
    expect(cap.sent[0]).not.toHaveProperty("ids");
  });

  it("omits symbol when not provided (clear-all-charts form)", async () => {
    const cap = captureSend();
    const handler = createClearZonesHandler({
      isConnected: () => true,
      send: cap.send,
    });

    await handler({});

    expect(cap.sent[0]).toEqual({ v: 1, type: "clear_zones" });
    expect(cap.sent[0]).not.toHaveProperty("symbol");
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
