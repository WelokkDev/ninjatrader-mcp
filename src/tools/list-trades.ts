import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ledger } from "../db/ledger.js";

// list_trades — read the persisted trades table (a thin filter→serialize shell
// over the ledger DAO). Filter by runId (a backtest run), mode
// (backtest/paper/live), and/or managementMode (fixed/trailing/constrained) to
// compare the three exit policies of a backtest run side by side.

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const MODES = ["backtest", "paper", "live"] as const;
const MGMT = ["fixed", "trailing", "constrained"] as const;

export interface ListTradesArgs {
  runId?: string;
  mode?: (typeof MODES)[number];
  managementMode?: (typeof MGMT)[number];
}

export function createListTradesHandler() {
  return async ({ runId, mode, managementMode }: ListTradesArgs): Promise<ToolResult> => {
    const trades = ledger.listTrades({ runId, mode, managementMode });
    return ok({ count: trades.length, trades });
  };
}

export function registerListTrades(server: McpServer): void {
  const handler = createListTradesHandler();

  server.tool(
    "list_trades",
    "List persisted trades from the ledger, optionally filtered by runId (a backtest run — see an experiment's provenance.runId), mode (backtest/paper/live), and/or managementMode (fixed/trailing/constrained). Each trade carries entry/stop/target/exit prices, exitReason, r_multiple, barsInTrade, and mfe. Note: for 'live'/imported trades, mfe carries the broker's realized P&L (dollars), not max-favorable-excursion-in-R, until a dedicated realized_pnl column lands.",
    {
      runId: z
        .string()
        .optional()
        .describe("Filter to a single backtest run id."),
      mode: z
        .enum(MODES)
        .optional()
        .describe("Filter by execution surface: backtest, paper, or live."),
      managementMode: z
        .enum(MGMT)
        .optional()
        .describe("Filter by exit-management policy: fixed, trailing, or constrained."),
    },
    handler,
  );
}
