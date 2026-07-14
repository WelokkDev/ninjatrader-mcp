import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lab } from "../lab/lab.js";

// experiment_result — the ~3KB normalized verdict (funnel + per-mode metrics +
// provenance + integrity report). NEVER the 176-307MB decisions.jsonl.

type ToolResult = { content: Array<{ type: "text"; text: string }> };
const ok = (payload: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
});

export function registerExperimentResult(server: McpServer, lab: Lab): void {
  server.tool(
    "experiment_result",
    "Get the normalized, token-tiny result for a finished experiment: funnel, per-mode metrics, provenance, and the integrity report (causal/cache/provenance verdicts). Returns {pending:true} if the run is not finished.",
    {
      experimentId: z.string().describe("The id returned by start_experiment."),
    },
    async ({ experimentId }): Promise<ToolResult> => {
      const status = lab.status(experimentId);
      if (!status) return ok({ error: `unknown experiment ${experimentId}` });
      const result = lab.result(experimentId);
      if (!result) return ok({ pending: true, status: status.status, etaText: status.etaText });
      return ok(result);
    },
  );
}
