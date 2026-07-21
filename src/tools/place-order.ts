import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { placeOrderFields } from "../bridge/protocol.js";
import { getExecutionService, type ExecutionService } from "../execution/service.js";
import type { OrderIntent } from "../execution/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// Tool params = the wire fields minus clientOrderId (the server owns the
// idempotency key) plus an optional rationale for the audit trail.
const { clientOrderId: _clientOrderId, ...wireFields } = placeOrderFields;
const placeOrderParams = {
  ...wireFields,
  reason: z.string().max(500).optional(),
};

type PlaceOrderArgs = {
  account: string;
  symbol: string;
  action: OrderIntent["action"];
  orderType: OrderIntent["orderType"];
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  tif: OrderIntent["tif"];
  reason?: string;
};

const DESCRIPTION =
  "Submit ONE order to a NinjaTrader account (the write path — this places a real order on whatever account you name). " +
  "Default-off and gated: it only reaches NT8 when trading is enabled AND the account is on the server allow-list AND the " +
  "quantity is within the cap — otherwise it is blocked and logged, never sent. Params: account (exact NT8 name), symbol " +
  "(e.g. 'MNQ', resolved to the front-month contract), action (Buy/Sell), orderType (Market/Limit/Stop/StopLimit), quantity " +
  "(contracts), tif (Day/Gtc), and limitPrice/stopPrice as the type requires (Limit→limitPrice, Stop→stopPrice, " +
  "StopLimit→both). A success ack means NT8 ACCEPTED the submit — it is NOT a fill and NOT proof the exchange took it; the " +
  "order can still be rejected asynchronously. Confirm the real outcome via get_positions / the live position feed. Not a " +
  "bracket: place protective stops/targets as their own orders after you see the entry fill.";

export function createPlaceOrderHandler(service: () => ExecutionService) {
  return async (args: PlaceOrderArgs): Promise<ToolResult> => {
    const intent: OrderIntent = {
      account: args.account,
      symbol: args.symbol,
      action: args.action,
      orderType: args.orderType,
      quantity: args.quantity,
      ...(args.limitPrice !== undefined ? { limitPrice: args.limitPrice } : {}),
      ...(args.stopPrice !== undefined ? { stopPrice: args.stopPrice } : {}),
      tif: args.tif,
      source: "claude",
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    };

    const result = await service().submit(intent);
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

export function registerPlaceOrder(server: McpServer): void {
  server.tool("place_order", DESCRIPTION, placeOrderParams, createPlaceOrderHandler(getExecutionService));
}
