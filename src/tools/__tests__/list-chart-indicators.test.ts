import { describe, it, expect } from "vitest";
import { createListChartIndicatorsHandler } from "../list-chart-indicators.js";
import type { InboundMessage } from "../../bridge/protocol.js";

const sma = {
  id: 3,
  name: "NinjaTrader.NinjaScript.Indicators.SMA",
  displayName: "SMA(20)",
  panel: -1,
  isOverlay: true,
  displacement: 0,
  readableDepth: "TwoHundredFiftySix",
  params: [{ name: "Period", label: "Period", value: 20 }],
  plots: [{ name: "SMA", color: "#FFFFA500", style: "Line" }],
};

const macd = {
  id: 4,
  name: "NinjaTrader.NinjaScript.Indicators.MACD",
  displayName: "MACD(12,26,9)",
  panel: 1,
  isOverlay: false,
  displacement: 0,
  readableDepth: "Infinite",
  params: [
    { name: "Fast", label: "Fast", value: 12 },
    { name: "Slow", label: "Slow", value: 26 },
  ],
  plots: [
    { name: "Macd", color: "#FF00FF00", style: "Line" },
    { name: "Avg", color: "#FFFF0000", style: "Line" },
  ],
};

const chart = {
  window: "MNQ 09-26  15 Second",
  symbol: "MNQ",
  instrument: "MNQ SEP26",
  timeframe: "15s",
  isActive: true,
  indicators: [sma, macd],
};

function response(
  overrides: Partial<{ charts: unknown[]; skippedWindows: number }> = {},
): InboundMessage {
  return {
    v: 1,
    id: "r1",
    type: "chart_indicators_response",
    charts: [chart],
    skippedWindows: 0,
    ...overrides,
  } as InboundMessage;
}

describe("list_chart_indicators handler", () => {
  it("reports disconnection without calling request", async () => {
    let called = false;
    const handler = createListChartIndicatorsHandler({
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

  it("returns the charts with a total indicator count", async () => {
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async () => response(),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    expect(parsed.chartCount).toBe(1);
    expect(parsed.indicatorCount).toBe(2);
    expect(parsed.charts[0].indicators[0].params[0].value).toBe(20);
    expect(parsed.skippedWindows).toBeUndefined();
  });

  it("counts indicators across every chart", async () => {
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async () =>
        response({ charts: [chart, { ...chart, timeframe: "5m", indicators: [sma] }] }),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    expect(parsed.chartCount).toBe(2);
    expect(parsed.indicatorCount).toBe(3);
  });

  it("reports a chart with no indicators as zero, not as an absent chart", async () => {
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async () => response({ charts: [{ ...chart, indicators: [] }] }),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    expect(parsed.chartCount).toBe(1);
    expect(parsed.indicatorCount).toBe(0);
  });

  it("surfaces skippedWindows when non-zero", async () => {
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async () => response({ skippedWindows: 2 }),
    });
    const parsed = JSON.parse((await handler({})).content[0].text);
    expect(parsed.skippedWindows).toBe(2);
  });

  it("forwards the symbol and timeframe filters", async () => {
    let captured: { type: string; payload: Record<string, unknown> } | undefined;
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async (type, payload) => {
        captured = { type, payload };
        return response();
      },
    });
    await handler({ symbol: "MNQ", timeframe: "15s" });
    expect(captured?.type).toBe("request_chart_indicators");
    expect(captured?.payload).toEqual({ symbol: "MNQ", timeframe: "15s" });
  });

  it("sends an empty payload when no filters are given", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = createListChartIndicatorsHandler({
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
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("Request request_chart_indicators (x) timed out after 6000ms");
      },
    });
    const text = (await handler({})).content[0].text;
    expect(text).toContain("recompile");
    expect(text).toContain("request_chart_indicators");
  });

  it("passes through a bridge error message", async () => {
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("window enumeration failed: boom");
      },
    });
    expect((await handler({})).content[0].text).toContain("window enumeration failed: boom");
  });

  it("rejects an unexpected response type", async () => {
    const handler = createListChartIndicatorsHandler({
      isConnected: () => true,
      request: async () => ({ v: 1, type: "heartbeat" }) as InboundMessage,
    });
    expect((await handler({})).content[0].text).toContain("unexpected response type");
  });
});
