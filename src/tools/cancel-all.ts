import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelAllFields } from "../bridge/protocol.js";
import { getExecutionService, type ExecutionService } from "../execution/service.js";
import type { CancelAllIntent } from "../execution/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

const cancelAllParams = {
  ...cancelAllFields,
  reason: z.string().max(500).optional(),
};

type CancelAllArgs = {
  account: string;
  symbol: string;
  reason?: string;
};

const DESCRIPTION =
  "Cancel EVERY working order for one instrument on one account — INCLUDING orders the human placed manually in " +
  "NinjaTrader, not just orders this server placed. Use with care; prefer cancel_order for a single order. " +
  "RISK-REDUCING: gated by the account allow-list only, so it works even while trading is disabled. The ack's " +
  "cancelledCount is a best-effort count of working orders seen at dispatch, not a confirmation — verify via " +
  "get_positions that nothing is left working. Retrying is safe. Does NOT touch the position itself; use flatten to " +
  "also close the position.";

export function createCancelAllHandler(service: () => ExecutionService) {
  return async (args: CancelAllArgs): Promise<ToolResult> => {
    const intent: CancelAllIntent = {
      account: args.account,
      symbol: args.symbol,
      source: "claude",
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    };

    const result = await service().cancelAll(intent);
    if (!result.ok) {
      return errorResult(result.error, {
        ok: false,
        ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
        ...(result.code ? { code: result.code } : {}),
        certainlyNotDispatched: result.certainlyNotDispatched === true,
      });
    }
    return jsonResult(result);
  };
}

export function registerCancelAll(server: McpServer): void {
  server.tool("cancel_all", DESCRIPTION, cancelAllParams, createCancelAllHandler(getExecutionService));
}
