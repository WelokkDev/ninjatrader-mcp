import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isConnected as defaultIsConnected,
  send as defaultSend,
} from "../bridge/index.js";
import type { ClearZonesMessage, OutboundMessage } from "../bridge/protocol.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export interface ClearZonesArgs {
  symbol?: string;
  ids?: string[];
}

export interface ClearZonesDeps {
  isConnected: () => boolean;
  send: (message: OutboundMessage) => boolean;
}

export function createClearZonesHandler(deps: ClearZonesDeps) {
  return async ({ symbol, ids }: ClearZonesArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling clear_zones.",
      );
    }

    const message: ClearZonesMessage = {
      v: 1,
      type: "clear_zones",
      ...(symbol !== undefined ? { symbol } : {}),
      ...(ids !== undefined && ids.length > 0 ? { ids } : {}),
    };

    const dispatched = deps.send(message);

    return jsonResult({ dispatched, symbol, ids: ids ?? null });
  };
}

export function registerClearZones(server: McpServer): void {
  const handler = createClearZonesHandler({
    isConnected: defaultIsConnected,
    send: defaultSend,
  });

  server.tool(
    "clear_zones",
    "Remove drawings previously created via draw or draw_zone (cleared by id/tag; works for any shape). Omit symbol to clear on every chart with the renderer attached. Provide ids to clear specific drawings; omit ids to clear all.",
    {
      symbol: z
        .string()
        .min(1)
        .optional()
        .describe("Restrict clear to a single chart symbol; omit to apply to all"),
      ids: z
        .array(z.string().min(1))
        .optional()
        .describe("Specific zone ids to clear; omit to clear all"),
    },
    handler,
  );
}
