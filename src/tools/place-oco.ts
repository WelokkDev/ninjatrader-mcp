import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { placeOcoFields } from "../bridge/protocol.js";
import { getExecutionService, type ExecutionService } from "../execution/service.js";
import type { OcoIntent } from "../execution/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// Drop server-derived ids (ocoId + both leg names derive from one base clientOrderId).
const {
  ocoId: _ocoId,
  stopClientOrderId: _stopId,
  targetClientOrderId: _targetId,
  ...ocoWireFields
} = placeOcoFields;

const placeOcoParams = {
  ...ocoWireFields,
  clientOrderId: z
    .string()
    .min(1)
    .max(47)
    .describe(
      "BASE idempotency key (≤47 chars; leg ids are derived as <base>:S / <base>:T) — " +
        "OMIT for new pairs (the server generates one). Set it ONLY to retry a place_oco " +
        "that returned an ambiguous result (timeout/disconnect), passing the exact " +
        "clientOrderId from that result so the AddOn dedupes instead of double-firing.",
    )
    .optional(),
  reason: z.string().max(500).optional(),
};

type PlaceOcoArgs = {
  account: string;
  symbol: string;
  action: OcoIntent["action"];
  quantity: number;
  stopPrice: number;
  limitPrice: number;
  tif: OcoIntent["tif"];
  clientOrderId?: string;
  reason?: string;
};

const DESCRIPTION =
  "Place an OCO EXIT PAIR on a NinjaTrader account: a protective stop (StopMarket at stopPrice) plus a profit target " +
  "(Limit at limitPrice), sharing action/quantity/tif, submitted atomically — when one leg fills or terminates, NT8 " +
  "cancels the sibling. Use it to bracket an EXISTING position after the entry fills (action is the EXIT side: Sell to " +
  "exit a long, Buy to exit a short). WARNING: a triggered exit on a flat account OPENS a position, so this rides the " +
  "full trading gate (enabled + allow-list + qty cap). Prices are tick-rounded by the AddOn; effective values are " +
  "echoed. A success ack means NT8 accepted the submit — NOT that the legs are working; confirm via get_positions / " +
  "the live position feed. Use change_order to trail the stop. Leave clientOrderId unset except to retry an ambiguous " +
  "result with the exact id you got back.";

export function createPlaceOcoHandler(service: () => ExecutionService) {
  return async (args: PlaceOcoArgs): Promise<ToolResult> => {
    const intent: OcoIntent = {
      account: args.account,
      symbol: args.symbol,
      action: args.action,
      quantity: args.quantity,
      stopPrice: args.stopPrice,
      limitPrice: args.limitPrice,
      tif: args.tif,
      ...(args.clientOrderId !== undefined ? { clientOrderId: args.clientOrderId } : {}),
      source: "claude",
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    };

    const result = await service().submitOco(intent);
    if (!result.ok) {
      return errorResult(result.error, {
        ok: false,
        clientOrderId: result.clientOrderId,
        ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
        certainlyNotSubmitted: result.certainlyNotSubmitted === true,
      });
    }
    return jsonResult(result);
  };
}

export function registerPlaceOco(server: McpServer): void {
  server.tool("place_oco", DESCRIPTION, placeOcoParams, createPlaceOcoHandler(getExecutionService));
}
