import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { changeOrderFields } from "../bridge/protocol.js";
import { getExecutionService, type ExecutionService } from "../execution/service.js";
import type { ChangeIntent } from "../execution/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

const changeOrderParams = {
  ...changeOrderFields,
  reason: z.string().max(500).optional(),
};

type ChangeOrderArgs = {
  account: string;
  clientOrderId: string;
  quantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  reason?: string;
};

const DESCRIPTION =
  "Amend a WORKING order in place (quantity and/or limitPrice and/or stopPrice — provide at least one), addressed by " +
  "its clientOrderId. The order stays working throughout — ALWAYS prefer this over cancel+replace: no naked window " +
  "with the position unprotected, and price queue position is kept where the change allows. This is how you trail a " +
  "stop (repeated stopPrice changes on the OCO stop leg). RISK-ADDING (a raised qty or widened stop adds exposure), " +
  "so it rides the full trading gate. Unspecified fields keep their current values. Prices are tick-rounded; the ack " +
  "echoes the effective values. The ack means the change REQUEST was accepted (e.g. ChangeSubmitted) — confirm via " +
  "get_positions / order events. An already-terminal error means the order filled or cancelled first. Retrying a " +
  "change is safe.";

export function createChangeOrderHandler(service: () => ExecutionService) {
  return async (args: ChangeOrderArgs): Promise<ToolResult> => {
    const intent: ChangeIntent = {
      account: args.account,
      clientOrderId: args.clientOrderId,
      ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
      ...(args.limitPrice !== undefined ? { limitPrice: args.limitPrice } : {}),
      ...(args.stopPrice !== undefined ? { stopPrice: args.stopPrice } : {}),
      source: "claude",
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    };

    const result = await service().change(intent);
    if (!result.ok) {
      return errorResult(result.error, {
        ok: false,
        clientOrderId: result.clientOrderId,
        ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
        ...(result.code ? { code: result.code } : {}),
        certainlyNotDispatched: result.certainlyNotDispatched === true,
      });
    }
    return jsonResult(result);
  };
}

export function registerChangeOrder(server: McpServer): void {
  server.tool("change_order", DESCRIPTION, changeOrderParams, createChangeOrderHandler(getExecutionService));
}
