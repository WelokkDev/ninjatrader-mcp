import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ledger } from "../db/ledger.js";
import { jsonResult, type ToolResult } from "./result.js";

// list_decisions — read the persisted trade_decisions table (a thin
// filter→serialize shell over the ledger DAO). One row per evaluated bar of a
// backtest walk, with verdict ('yes'/'no'), the short reason code, and the
// full per-step trace. Filter by runId and/or verdict to build the "stall
// funnel": how many bars died at each decision step, by reason.

export interface ListDecisionsArgs {
  runId?: string;
  verdict?: "yes" | "no";
  reasonsOnly?: boolean;
  limit?: number;
}

export function createListDecisionsHandler() {
  // SAFETY: defaults to the cheap funnel (reasonsOnly=true). The full-trace path
  // is opt-in AND hard-capped — a real run holds ~15k full-trace rows (176MB+),
  // so an uncapped dump would blow the caller's context instantly.
  return async ({ runId, verdict, reasonsOnly = true, limit = 200 }: ListDecisionsArgs): Promise<ToolResult> => {
    const decisions = ledger.listDecisions({ runId, verdict });
    if (reasonsOnly) {
      // The stall funnel: count 'no' bars by their short reason code.
      const funnel: Record<string, number> = {};
      let yes = 0;
      for (const d of decisions) {
        if (d.verdict === "yes") yes++;
        else funnel[d.reason ?? "unknown"] = (funnel[d.reason ?? "unknown"] ?? 0) + 1;
      }
      return jsonResult({ count: decisions.length, yes, funnel });
    }
    const cap = Math.max(1, Math.min(limit, 2000));
    const capped = decisions.slice(0, cap);
    return jsonResult({ count: decisions.length, returned: capped.length, decisions: capped });
  };
}

export function registerListDecisions(server: McpServer): void {
  const handler = createListDecisionsHandler();

  server.tool(
    "list_decisions",
    "List persisted per-bar decisions from a backtest walk (one row per evaluated 5m close), with verdict ('yes'/'no'), short reason code, and the full step trace. Pass reasonsOnly=true for the 'stall funnel' — a count of 'no' bars grouped by which decision step killed them. Filter by runId and/or verdict.",
    {
      runId: z
        .string()
        .optional()
        .describe("Filter to a single backtest run id."),
      verdict: z
        .enum(["yes", "no"])
        .optional()
        .describe("Filter to 'yes' or 'no' decisions."),
      reasonsOnly: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Default true → return the stall funnel (counts of 'no' bars by reason code). Set false to get full decision rows (capped by `limit`).",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .default(200)
        .describe("Max full decision rows when reasonsOnly=false (hard-capped at 2000)."),
    },
    handler,
  );
}
