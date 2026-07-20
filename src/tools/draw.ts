import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected, send as defaultSend, getBridgeStatus } from "../bridge/index.js";
import { drawShapeSchema, drawStyleSchema } from "../bridge/protocol.js";
import type { DrawMessage, DrawShape, DrawStyle, OutboundMessage } from "../bridge/protocol.js";
import { drawTargetWarning } from "./draw-target.js";
import { jsonResult, textResult, type ToolResult } from "./result.js";

export interface DrawArgs {
  id: string;
  symbol: string;
  shape: DrawShape;
  style?: DrawStyle;
}

export interface DrawDeps {
  isConnected: () => boolean;
  send: (message: OutboundMessage) => boolean;
  knownInstruments: () => string[];
}

export function createDrawHandler(deps: DrawDeps) {
  return async ({ id, symbol, shape, style }: DrawArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return textResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling draw.",
      );
    }
    const message: DrawMessage = {
      v: 1,
      type: "draw",
      id,
      symbol,
      shape,
      ...(style !== undefined ? { style } : {}),
    };
    const dispatched = deps.send(message);
    const warning = drawTargetWarning(symbol, deps.knownInstruments());
    return jsonResult({ dispatched, id, symbol, shape, style, ...(warning ? { warning } : {}) });
  };
}

export function registerDraw(server: McpServer): void {
  const handler = createDrawHandler({
    isConnected: defaultIsConnected,
    send: defaultSend,
    knownInstruments: () => getBridgeStatus().instruments,
  });
  server.tool(
    "draw",
    "Draw a chart primitive on the matching NinjaTrader chart. shape is one of: rectangle {proximal,distal,fromTs?,toTs?}, hline {price,fromTs?,toTs?}, vline {ts}, text {ts,price,text}. Optional style {color '#rrggbb', opacity 0..1, label}. id is the draw tag (use clear_zones to remove). TIMEZONE: interpret natural-language dates as America/New_York calendar dates (see src/core/time.ts etDayStart/etDayEnd). For zone/analysis requests ('draw the two zones', 'analyze my chart and draw supply & demand'), consult draw.md at repo root (if present) for the role->style palette and the analyze->draw recipe before drawing.",
    { id: z.string().min(1), symbol: z.string().min(1), shape: drawShapeSchema, style: drawStyleSchema.optional() },
    handler,
  );
}
