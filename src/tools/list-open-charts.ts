import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected, request as defaultRequest } from "../bridge/index.js";
import type { InboundMessage } from "../bridge/protocol.js";

export interface ListOpenChartsDeps {
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<InboundMessage>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export const OPEN_CHARTS_TIMEOUT_MS = 5_000;

export function createListOpenChartsHandler(deps: ListOpenChartsDeps) {
  const text = (t: string): ToolResult => ({ content: [{ type: "text" as const, text: t }] });
  return async (): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return text(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling list_open_charts.",
      );
    }
    let res: InboundMessage;
    try {
      res = await deps.request("request_open_charts", {}, OPEN_CHARTS_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        return text(
          `list_open_charts timed out after ${OPEN_CHARTS_TIMEOUT_MS}ms — either NT8's UI is busy, or the AddOn predates request_open_charts (recompile ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor).`,
        );
      }
      return text(`list_open_charts failed: ${msg}`);
    }
    if (res.type !== "open_charts_response") {
      return text(`list_open_charts failed: unexpected response type '${res.type}'`);
    }
    return text(
      JSON.stringify({
        chartCount: res.charts.length,
        charts: res.charts,
        ...(res.skippedWindows > 0 ? { skippedWindows: res.skippedWindows } : {}),
      }),
    );
  };
}

export function registerListOpenCharts(server: McpServer): void {
  const handler = createListOpenChartsHandler({
    isConnected: defaultIsConnected,
    request: defaultRequest,
  });
  server.tool(
    "list_open_charts",
    "List every chart currently open in NinjaTrader 8 — one entry per chart tab: {window, symbol, instrument, timeframe, isActive (selected tab of its window), hasRenderer (draw target ready)}. Chart-targeting etiquette: when the user references 'the chart'/'my chart' without naming an instrument or timeframe, call this first; if exactly one chart is open, target it without asking; if several are open, ask the user to pick (offer symbol+timeframe options; the active tab is the natural default). symbol matches what draw/draw_zone/clear_zones expect. Draws only render where hasRenderer is true.",
    {},
    handler,
  );
}
