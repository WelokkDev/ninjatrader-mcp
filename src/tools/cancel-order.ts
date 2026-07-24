import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelOrderFields } from "../bridge/protocol.js";
import { getExecutionService, type ExecutionService } from "../execution/service.js";
import type { CancelIntent } from "../execution/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

const cancelOrderParams = {
  ...cancelOrderFields,
  reason: z.string().max(500).optional(),
};

type CancelOrderArgs = {
  account: string;
  clientOrderId: string;
  reason?: string;
};

const DESCRIPTION =
  "Cancel ONE working order, addressed by the clientOrderId returned when it was placed (= its NT8 order Name). " +
  "RISK-REDUCING: gated by the account allow-list only, so it works even while trading is disabled — no qty cap, no " +
  "rate limit. A success ack means the cancel REQUEST was accepted (state e.g. CancelSubmitted), NOT that the order is " +
  "gone: watch get_positions / the order event stream for state Cancelled — a fill can still beat the cancel. An " +
  "already-terminal error tells you which way it went (Filled vs Cancelled). Retrying a cancel is always safe. A " +
  "partially filled order keeps its filled portion; only the remainder is cancelled. CAUTION — OCO legs: if this order " +
  "is one leg of a place_oco bracket (ids '<base>:S' / '<base>:T'), cancelling it ALSO cancels its sibling, so " +
  "cancelling the target leaves the position with NO protective stop. To adjust or tighten one leg while keeping the " +
  "position protected, use change_order on that leg — not cancel_order.";

export function createCancelOrderHandler(service: () => ExecutionService) {
  return async (args: CancelOrderArgs): Promise<ToolResult> => {
    const intent: CancelIntent = {
      account: args.account,
      clientOrderId: args.clientOrderId,
      source: "claude",
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    };

    const result = await service().cancel(intent);
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

export function registerCancelOrder(server: McpServer): void {
  server.tool("cancel_order", DESCRIPTION, cancelOrderParams, createCancelOrderHandler(getExecutionService));
}
