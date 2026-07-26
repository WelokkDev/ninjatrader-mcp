import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected, request as defaultRequest } from "../bridge/index.js";
import type { InboundMessage } from "../bridge/protocol.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export interface ListChartIndicatorsArgs {
  symbol?: string;
  timeframe?: string;
}

export interface ListChartIndicatorsDeps {
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<InboundMessage>;
}

// Longer than the other chart reads: reflection over every indicator, behind a
// 4s AddOn dispatcher budget.
export const CHART_INDICATORS_TIMEOUT_MS = 6_000;

export function createListChartIndicatorsHandler(deps: ListChartIndicatorsDeps) {
  return async (args: ListChartIndicatorsArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling list_chart_indicators.",
      );
    }
    const payload: Record<string, unknown> = {};
    if (args.symbol !== undefined) payload.symbol = args.symbol;
    if (args.timeframe !== undefined) payload.timeframe = args.timeframe;

    let res: InboundMessage;
    try {
      res = await deps.request("request_chart_indicators", payload, CHART_INDICATORS_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        return errorResult(
          `list_chart_indicators timed out after ${CHART_INDICATORS_TIMEOUT_MS}ms — either NT8's UI is busy, or the AddOn predates request_chart_indicators (recompile ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor).`,
        );
      }
      return errorResult(`list_chart_indicators failed: ${msg}`);
    }
    if (res.type !== "chart_indicators_response") {
      return errorResult(`list_chart_indicators failed: unexpected response type '${res.type}'`);
    }

    const indicatorCount = res.charts.reduce((n, c) => n + c.indicators.length, 0);
    return jsonResult({
      chartCount: res.charts.length,
      indicatorCount,
      charts: res.charts,
      ...(res.skippedWindows > 0 ? { skippedWindows: res.skippedWindows } : {}),
    });
  };
}

export function registerListChartIndicators(server: McpServer): void {
  const handler = createListChartIndicatorsHandler({
    isConnected: defaultIsConnected,
    request: defaultRequest,
  });
  server.tool(
    "list_chart_indicators",
    "Discover the indicators attached to your open NinjaTrader 8 charts — step 1 of the two-step indicator read (step 2 is read_indicator_values). Per chart tab: {window, symbol, instrument, timeframe, isActive, indicators:[...]}; per indicator: {id, name (full NT8 type name), displayName ('SMA(20)'), panel (-1 = price panel), isOverlay, displacement, readableDepth, params:[{name, label, value}], plots:[{name, color, style}]}. params lists only the indicator's OWN settings (Period, Fast/Slow/Smooth, …) — the properties every NinjaScript inherits (Calculate, Panel, Visible, …) are omitted as plumbing. WORKFLOW: call this once to get an indicator's `id`, then poll read_indicator_values with that id — it is far cheaper than re-listing. The id is stable within a session but a chart reload or timeframe switch recreates indicators and invalidates it; when a read comes back found:false, call this again. readableDepth is the instance's value-retention setting ('TwoHundredFiftySix' | 'Infinite'), i.e. how far back values can be read — NOT how much history the chart loaded. This tool is read-only: it cannot add, remove, or reconfigure indicators. Optional symbol/timeframe filters use the same targeting vocabulary as list_open_charts; omit both to cover every open chart.",
    {
      symbol: z.string().min(1).optional(),
      timeframe: z.string().min(1).optional(),
    },
    handler,
  );
}
