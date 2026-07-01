import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected, send as defaultSend } from "../bridge/index.js";
import type { DrawMessage, DrawShape, DrawStyle, OutboundMessage } from "../bridge/protocol.js";

export interface DrawArgs {
  id: string;
  symbol: string;
  shape: DrawShape;
  style?: DrawStyle;
}

export interface DrawDeps {
  isConnected: () => boolean;
  send: (message: OutboundMessage) => boolean;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const shapeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rectangle"),
    proximal: z.number(),
    distal: z.number(),
    fromTs: z.number().int().optional(),
    toTs: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("hline"),
    price: z.number(),
    fromTs: z.number().int().optional(),
    toTs: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("vline"), ts: z.number().int() }),
  z.object({ kind: z.literal("text"), ts: z.number().int(), price: z.number(), text: z.string().min(1) }),
]);

const styleSchema = z
  .object({
    color: z.string().optional(),
    opacity: z.number().min(0).max(1).optional(),
    label: z.string().optional(),
  })
  .optional();

export function createDrawHandler(deps: DrawDeps) {
  return async ({ id, symbol, shape, style }: DrawArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling draw.",
          },
        ],
      };
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
    return { content: [{ type: "text" as const, text: JSON.stringify({ dispatched, id, symbol, shape, style }) }] };
  };
}

export function registerDraw(server: McpServer): void {
  const handler = createDrawHandler({ isConnected: defaultIsConnected, send: defaultSend });
  server.tool(
    "draw",
    "Draw a chart primitive on the matching NinjaTrader chart. shape is one of: rectangle {proximal,distal,fromTs?,toTs?}, hline {price,fromTs?,toTs?}, vline {ts}, text {ts,price,text}. Optional style {color '#rrggbb', opacity 0..1, label}. id is the draw tag (use clear_zones to remove). TIMEZONE: interpret natural-language dates as America/New_York calendar dates (see src/core/time.ts etDayStart/etDayEnd). For under-specified requests ('draw the two zones'), consult drawing.config.json at repo root for role->style and named views before drawing.",
    { id: z.string().min(1), symbol: z.string().min(1), shape: shapeSchema, style: styleSchema },
    handler,
  );
}
