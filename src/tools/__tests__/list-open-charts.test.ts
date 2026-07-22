import { describe, it, expect } from "vitest";
import { createListOpenChartsHandler } from "../list-open-charts.js";
import type { InboundMessage } from "../../bridge/protocol.js";

const entry = {
  window: "Chart",
  symbol: "MNQ",
  instrument: "MNQ SEP26",
  timeframe: "5m",
  isActive: true,
  hasRenderer: true,
};

function response(overrides: Partial<{ charts: unknown[]; skippedWindows: number }> = {}): InboundMessage {
  return {
    v: 1,
    id: "r1",
    type: "open_charts_response",
    charts: [entry],
    skippedWindows: 0,
    ...overrides,
  } as InboundMessage;
}

describe("list_open_charts handler", () => {
  it("reports disconnection without calling request", async () => {
    let called = false;
    const handler = createListOpenChartsHandler({
      isConnected: () => false,
      request: async () => {
        called = true;
        return response();
      },
    });
    const res = await handler();
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain("not connected");
    expect(called).toBe(false);
  });

  it("returns the charts as JSON", async () => {
    const handler = createListOpenChartsHandler({
      isConnected: () => true,
      request: async () => response(),
    });
    const res = await handler();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.chartCount).toBe(1);
    expect(parsed.charts).toEqual([entry]);
    expect(parsed.skippedWindows).toBeUndefined();
  });

  it("surfaces skippedWindows when non-zero", async () => {
    const handler = createListOpenChartsHandler({
      isConnected: () => true,
      request: async () => response({ skippedWindows: 2 }),
    });
    const parsed = JSON.parse((await handler()).content[0].text);
    expect(parsed.skippedWindows).toBe(2);
  });

  it("rewrites a timeout into the stale-addon hint", async () => {
    const handler = createListOpenChartsHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("Request request_open_charts (x) timed out after 5000ms");
      },
    });
    const text = (await handler()).content[0].text;
    expect(text).toContain("recompile");
    expect(text).not.toContain("downloading history");
  });

  it("passes through a bridge error message", async () => {
    const handler = createListOpenChartsHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("window enumeration failed: boom");
      },
    });
    expect((await handler()).content[0].text).toContain("window enumeration failed: boom");
  });

  it("rejects an unexpected response type", async () => {
    const handler = createListOpenChartsHandler({
      isConnected: () => true,
      request: async () => ({ v: 1, type: "heartbeat" }) as InboundMessage,
    });
    expect((await handler()).content[0].text).toContain("unexpected response type");
  });
});
