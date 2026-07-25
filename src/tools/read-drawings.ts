import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected, request as defaultRequest } from "../bridge/index.js";
import type { InboundMessage } from "../bridge/protocol.js";
import { formatExchangeTime } from "../core/time.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export interface GetDrawingsArgs {
  symbol?: string;
  toolType?: string;
  userDrawnOnly?: boolean;
}

export interface GetDrawingsDeps {
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<InboundMessage>;
}

export const GET_DRAWINGS_TIMEOUT_MS = 5_000;

export function createGetDrawingsHandler(deps: GetDrawingsDeps) {
  return async (args: GetDrawingsArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling get_drawings.",
      );
    }
    const payload: Record<string, unknown> = {};
    if (args.symbol !== undefined) payload.symbol = args.symbol;
    if (args.toolType !== undefined) payload.toolType = args.toolType;
    if (args.userDrawnOnly !== undefined) payload.userDrawnOnly = args.userDrawnOnly;

    let res: InboundMessage;
    try {
      res = await deps.request("request_drawings", payload, GET_DRAWINGS_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        return errorResult(
          `get_drawings timed out after ${GET_DRAWINGS_TIMEOUT_MS}ms — either NT8's UI is busy, or the AddOn predates request_drawings (recompile ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor).`,
        );
      }
      return errorResult(`get_drawings failed: ${msg}`);
    }
    if (res.type !== "drawings_response") {
      return errorResult(`get_drawings failed: unexpected response type '${res.type}'`);
    }

    // Surface a human-readable ET time next to each anchor's unix ts.
    const drawings = res.drawings.map((d) => ({
      ...d,
      anchors: d.anchors.map((a) => ({
        ...a,
        ...(a.ts !== undefined ? { time: formatExchangeTime(a.ts) } : {}),
      })),
    }));
    const riskRewardCount = drawings.filter((d) => d.riskReward).length;

    return jsonResult({
      drawingCount: drawings.length,
      ...(riskRewardCount > 0 ? { riskRewardCount } : {}),
      drawings,
      ...(res.skippedWindows > 0 ? { skippedWindows: res.skippedWindows } : {}),
    });
  };
}

export function registerGetDrawings(server: McpServer): void {
  const handler = createGetDrawingsHandler({
    isConnected: defaultIsConnected,
    request: defaultRequest,
  });
  server.tool(
    "get_drawings",
    "Read the drawing tools currently on your NinjaTrader 8 charts — including the ones you drew by hand. Each entry: {window, symbol, timeframe, tag, toolType (NT8's own type name, e.g. 'RiskReward'/'Ray'/'HorizontalLine'), isUserDrawn, isVisible, text?, anchors:[{price, ts, time}]}. RISK/REWARD: every RiskReward tool also carries a parsed riskReward:{entry, stop, target, direction (long|short|flat), riskPoints, rewardPoints, computedRatio, ratio} — so you can read a hand-drawn R:R setup's entry/stop/target and its reward-to-risk ratio directly. Filters (all optional): symbol restricts to one instrument's charts (master symbol as in list_open_charts, e.g. 'MNQ'); toolType restricts to one tool (pass 'RiskReward' to read only R:R setups); userDrawnOnly:true drops script-drawn objects (including this MCP's own zones/targets), leaving just what you drew. Targeting etiquette matches list_open_charts — when the user says 'my chart' ambiguously and several are open, prefer filtering by symbol. Only charts with the McpBridgeRenderer indicator attached are guaranteed readable. Timestamps are unix seconds; time is the same instant in America/New_York (draw convention).",
    {
      symbol: z.string().min(1).optional(),
      toolType: z.string().min(1).optional(),
      userDrawnOnly: z.boolean().optional(),
    },
    handler,
  );
}
