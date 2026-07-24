import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { flattenFields } from "../bridge/protocol.js";
import { getExecutionService, type ExecutionService } from "../execution/service.js";
import type { FlattenIntent } from "../execution/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

const flattenParams = {
  ...flattenFields,
  reason: z.string().max(500).optional(),
};

type FlattenArgs = {
  account: string;
  symbol: string;
  reason?: string;
};

const DESCRIPTION =
  "EMERGENCY EXIT for one instrument on one account: cancels ALL working orders (including manually placed ones) AND " +
  "closes any open position at MARKET. This is the panic button — use it when the position must be gone now, accepting " +
  "market-order slippage. RISK-REDUCING: gated by the account allow-list only, so it works even while trading is " +
  "disabled — that is exactly when it matters. The ack means NT8 accepted the flatten request; confirm the account is " +
  "actually flat (position zero, no working orders) via get_positions. Retrying is safe — flattening a flat instrument " +
  "is a no-op.";

export function createFlattenHandler(service: () => ExecutionService) {
  return async (args: FlattenArgs): Promise<ToolResult> => {
    const intent: FlattenIntent = {
      account: args.account,
      symbol: args.symbol,
      source: "claude",
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    };

    const result = await service().flatten(intent);
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

export function registerFlatten(server: McpServer): void {
  server.tool("flatten", DESCRIPTION, flattenParams, createFlattenHandler(getExecutionService));
}
