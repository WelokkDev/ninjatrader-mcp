import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected, request as defaultRequest } from "../bridge/index.js";
import type { InboundMessage } from "../bridge/protocol.js";
import { formatExchangeTime } from "../core/time.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export interface NavigateChartArgs {
  symbol: string;
  ts?: number;
  timeframe?: string;
  barsOnScreen?: number;
  align?: "center" | "right";
  activate?: boolean;
}

export interface NavigateChartDeps {
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<InboundMessage>;
}

export const NAVIGATE_CHART_TIMEOUT_MS = 5_000;

export function createNavigateChartHandler(deps: NavigateChartDeps) {
  return async (args: NavigateChartArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling navigate_chart.",
      );
    }
    if (args.ts === undefined && args.barsOnScreen === undefined) {
      return errorResult(
        "navigate_chart needs ts (scroll target) and/or barsOnScreen (zoom) — with neither there is nothing to do.",
      );
    }
    const payload: Record<string, unknown> = { symbol: args.symbol };
    if (args.ts !== undefined) payload.ts = args.ts;
    if (args.timeframe !== undefined) payload.timeframe = args.timeframe;
    if (args.barsOnScreen !== undefined) payload.barsOnScreen = args.barsOnScreen;
    if (args.align !== undefined) payload.align = args.align;
    if (args.activate !== undefined) payload.activate = args.activate;

    let res: InboundMessage;
    try {
      res = await deps.request("navigate_chart", payload, NAVIGATE_CHART_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        return errorResult(
          `navigate_chart timed out after ${NAVIGATE_CHART_TIMEOUT_MS}ms — either NT8's UI is busy, or the AddOn predates navigate_chart (recompile ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor).`,
        );
      }
      return errorResult(`navigate_chart failed: ${msg}`);
    }
    if (res.type !== "navigate_chart_ack") {
      return errorResult(`navigate_chart failed: unexpected response type '${res.type}'`);
    }
    const results = res.results.map((r) => ({
      ...r,
      ...(r.visibleFromTs !== undefined ? { visibleFrom: formatExchangeTime(r.visibleFromTs) } : {}),
      ...(r.visibleToTs !== undefined ? { visibleTo: formatExchangeTime(r.visibleToTs) } : {}),
      ...(r.firstLoadedTs !== undefined ? { firstLoaded: formatExchangeTime(r.firstLoadedTs) } : {}),
      ...(r.lastLoadedTs !== undefined ? { lastLoaded: formatExchangeTime(r.lastLoadedTs) } : {}),
    }));
    return jsonResult({
      matched: res.matched,
      results,
      ...(res.skippedWindows > 0 ? { skippedWindows: res.skippedWindows } : {}),
    });
  };
}

export function registerNavigateChart(server: McpServer): void {
  const handler = createNavigateChartHandler({
    isConnected: defaultIsConnected,
    request: defaultRequest,
  });
  server.tool(
    "navigate_chart",
    "Scroll and/or zoom an open NinjaTrader chart — the programmatic Go To. Scroll: ts (unix seconds) is the target time; align 'center' (default) centers it on screen, 'right' puts it at the right edge. Zoom: barsOnScreen sets roughly how many bars span the canvas. Targeting: symbol as in list_open_charts (same etiquette — call it first when 'the chart' is ambiguous); optional timeframe ('5m') picks one tab when a symbol has several; every matching tab navigates. activate (default true) selects the tab and focuses the window. TIMEZONE: interpret natural-language times as America/New_York (draw convention). The response reports the now-visible range (visibleFrom/visibleTo); 'clamped' means the target is outside the chart's loaded bars — increasing the chart's Days To Load in NT8 is the fix, this tool cannot load more history.",
    {
      symbol: z.string().min(1),
      ts: z.number().int().optional(),
      timeframe: z.string().optional(),
      barsOnScreen: z.number().int().min(2).max(5000).optional(),
      align: z.enum(["center", "right"]).optional(),
      activate: z.boolean().optional(),
    },
    handler,
  );
}
