import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isConnected as defaultIsConnected,
  send as defaultSend,
} from "../bridge/index.js";
import type { ClearZonesMessage, OutboundMessage } from "../bridge/protocol.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";
import { STDIO_SESSION, type SessionContext } from "./session.js";

export interface ClearZonesArgs {
  symbol?: string;
  ids?: string[];
  all?: boolean;
}

export interface ClearZonesDeps {
  isConnected: () => boolean;
  send: (message: OutboundMessage) => boolean;
  drawn?: Map<string, Set<string>>;
}

export function createClearZonesHandler(deps: ClearZonesDeps) {
  return async ({ symbol, ids, all }: ClearZonesArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling clear_zones.",
      );
    }

    const drawn = deps.drawn ?? new Map<string, Set<string>>();
    const charts = [...drawn].filter(([s]) => symbol === undefined || s === symbol);
    let target: string[] | undefined = ids && ids.length > 0 ? ids : undefined;
    let scope: "ids" | "all" | "own" = target ? "ids" : "all";
    if (!target && !all) {
      target = [...new Set(charts.flatMap(([, own]) => [...own]))];
      scope = "own";
      if (target.length === 0) {
        return errorResult(
          "This conversation has drawn nothing" +
            (symbol ? ` on ${symbol}` : "") +
            ". Pass ids to clear specific drawings, or all:true to clear every drawing on the chart(s) — including other conversations'.",
          { cleared: [] },
        );
      }
    }

    const message: ClearZonesMessage = {
      v: 1,
      type: "clear_zones",
      ...(symbol !== undefined ? { symbol } : {}),
      ...(target ? { ids: target } : {}),
    };
    const dispatched = deps.send(message);
    // Same semantics as the AddOn's StoreClear.
    if (dispatched) {
      for (const [s, own] of charts) {
        if (target) for (const id of target) own.delete(id);
        if (!target || own.size === 0) drawn.delete(s);
      }
    }

    return jsonResult({ dispatched, symbol, scope, ids: target ?? null });
  };
}

export function registerClearZones(server: McpServer, session: SessionContext = STDIO_SESSION): void {
  const handler = createClearZonesHandler({
    isConnected: defaultIsConnected,
    send: defaultSend,
    drawn: session.drawn,
  });

  server.tool(
    "clear_zones",
    "Remove drawings previously created via draw or a scan's draw path (cleared by id/tag; works for any shape). Omit symbol to act on every chart with the renderer attached. Scope: with ids, exactly those; with all:true, EVERY drawing, including ones other conversations or scans created; with neither, only what THIS conversation drew (the safe default when several conversations share the charts).",
    {
      symbol: z
        .string()
        .min(1)
        .optional()
        .describe("Restrict clear to a single chart symbol; omit to apply to all"),
      ids: z
        .array(z.string().min(1))
        .optional()
        .describe("Specific zone ids to clear"),
      all: z
        .boolean()
        .optional()
        .describe("Clear every drawing, not just this conversation's own"),
    },
    handler,
  );
}
