import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lab } from "../lab/lab.js";

// experiment_status — live progress for a running (or finished) experiment:
// status, phase, percent, ETA, and the last few observability events. Token-tiny.

type ToolResult = { content: Array<{ type: "text"; text: string }> };
const ok = (payload: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
});

export function registerExperimentStatus(server: McpServer, lab: Lab): void {
  server.tool(
    "experiment_status",
    "Get live status for an experiment: status, phase, percent complete, ETA (p50 + honest band), and recent events. Never returns heavy trace data.",
    {
      experimentId: z.string().describe("The id returned by start_experiment."),
    },
    async ({ experimentId }): Promise<ToolResult> => {
      const view = lab.status(experimentId);
      if (!view) return ok({ error: `unknown experiment ${experimentId}` });
      return ok(view);
    },
  );
}
