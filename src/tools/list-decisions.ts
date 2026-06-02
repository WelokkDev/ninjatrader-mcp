import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ledger } from "../db/ledger.js";

// list_decisions — read the persisted trade_decisions table (a thin
// filter→serialize shell over the ledger DAO). One row per evaluated bar of a
// run_backtest walk, with verdict ('yes'/'no'), the short reason code, and the
// full per-step trace. Filter by runId and/or verdict to build the "stall
// funnel": how many bars died at each decision step, by reason.

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export interface ListDecisionsArgs {
  runId?: string;
  verdict?: "yes" | "no";
  reasonsOnly?: boolean;
}

export function createListDecisionsHandler() {
  return async ({ runId, verdict, reasonsOnly }: ListDecisionsArgs): Promise<ToolResult> => {
    const decisions = ledger.listDecisions({ runId, verdict });
    if (reasonsOnly) {
      // The stall funnel: count 'no' bars by their short reason code.
      const funnel: Record<string, number> = {};
      let yes = 0;
      for (const d of decisions) {
        if (d.verdict === "yes") yes++;
        else funnel[d.reason ?? "unknown"] = (funnel[d.reason ?? "unknown"] ?? 0) + 1;
      }
      return ok({ count: decisions.length, yes, funnel });
    }
    return ok({ count: decisions.length, decisions });
  };
}

export function registerListDecisions(server: McpServer): void {
  const handler = createListDecisionsHandler();

  server.tool(
    "list_decisions",
    "List persisted per-bar decisions from a run_backtest walk (one row per evaluated 5m close), with verdict ('yes'/'no'), short reason code, and the full step trace. Pass reasonsOnly=true for the 'stall funnel' — a count of 'no' bars grouped by which decision step killed them. Filter by runId and/or verdict.",
    {
      runId: z
        .string()
        .optional()
        .describe("Filter to a single backtest run id (from run_backtest)."),
      verdict: z
        .enum(["yes", "no"])
        .optional()
        .describe("Filter to 'yes' or 'no' decisions."),
      reasonsOnly: z
        .boolean()
        .optional()
        .describe(
          "When true, return the stall funnel (counts of 'no' bars by reason code) instead of the full decision rows.",
        ),
    },
    handler,
  );
}
