import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isConnected as defaultIsConnected,
  send as defaultSend,
} from "../bridge/index.js";
import { drawZoneFields } from "../bridge/protocol.js";
import type { DrawZoneMessage, OutboundMessage } from "../bridge/protocol.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export interface DrawZoneArgs {
  id: string;
  symbol: string;
  proximal: number;
  distal: number;
  fromTs?: number;
  toTs?: number;
}

export interface DrawZoneDeps {
  isConnected: () => boolean;
  send: (message: OutboundMessage) => boolean;
}

export function createDrawZoneHandler(deps: DrawZoneDeps) {
  return async ({
    id,
    symbol,
    proximal,
    distal,
    fromTs,
    toTs,
  }: DrawZoneArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling draw_zone.",
      );
    }

    const message: DrawZoneMessage = {
      v: 1,
      type: "draw_zone",
      id,
      symbol,
      proximal,
      distal,
      ...(fromTs !== undefined ? { fromTs } : {}),
      ...(toTs !== undefined ? { toTs } : {}),
    };

    const dispatched = deps.send(message);

    return jsonResult({ dispatched, id, symbol, proximal, distal, fromTs, toTs });
  };
}

export function registerDrawZone(server: McpServer): void {
  const handler = createDrawZoneHandler({
    isConnected: defaultIsConnected,
    send: defaultSend,
  });

  server.tool(
    "draw_zone",
    "DEPRECATED — prefer the generic `draw` tool; only use draw_zone when the user explicitly says \"draw_zone\". Draw a price zone rectangle on the matching NinjaTrader chart. Provide proximal/distal prices and an id (used as the draw tag). Optional fromTs/toTs (unix seconds) anchor the rectangle in chart time; omitting toTs extends to the current bar, omitting fromTs falls back to a fixed bars-back anchor. TIMEZONE CONVENTION: when a user gives natural-language dates (\"April 30 to May 1\"), interpret them as calendar dates in America/New_York (Exchange Time): fromTs = 00:00:00 ET on the start date, toTs = 23:59:59 ET on the end date (inclusive end-of-day). Use the helpers in src/core/time.ts (etDayStart, etDayEnd) to compute these.",
    {
      id: drawZoneFields.id.describe("Unique zone id; used as the draw tag"),
      symbol: drawZoneFields.symbol.describe("Symbol of the chart to draw on (e.g. NQ, ES)"),
      proximal: drawZoneFields.proximal.describe("Proximal price boundary"),
      distal: drawZoneFields.distal.describe("Distal price boundary"),
      fromTs: drawZoneFields.fromTs.describe("Zone start time (unix seconds)"),
      toTs: drawZoneFields.toTs.describe(
        "Zone end time (unix seconds); omit to extend to current bar",
      ),
    },
    handler,
  );
}
