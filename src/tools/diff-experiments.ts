import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lab } from "../lab/lab.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// diff_experiments — side-by-side of two finished experiments: funnel yes-delta,
// per-reason deltas, per-mode metric deltas, and a CAUTION when config/engine
// differ (funnel deltas are not a clean A/B when a gate moved).

export function registerDiffExperiments(server: McpServer, lab: Lab): void {
  server.tool(
    "diff_experiments",
    "Diff two finished experiments: funnel yes-delta, per-reason deltas, per-mode metric deltas, and a caution flag if config/engine differ (yield can move just by loosening a gate).",
    {
      a: z.string().describe("First experiment id (baseline)."),
      b: z.string().describe("Second experiment id (variant)."),
    },
    async ({ a, b }): Promise<ToolResult> => {
      try {
        return jsonResult(lab.diff(a, b));
      } catch (e) {
        return errorResult(String(e instanceof Error ? e.message : e));
      }
    },
  );
}
