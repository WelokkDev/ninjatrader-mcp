import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lab } from "../lab/lab.js";
import { jsonResult, type ToolResult } from "./result.js";

// list_experiments — compact summaries (id, status, label, yes-count, trades by
// mode, integrity ok). Explicit small fields only; never the full records.

export function registerListExperiments(server: McpServer, lab: Lab): void {
  server.tool(
    "list_experiments",
    "List experiments (newest first) as compact summaries: id, status, label, yes-count, trades-by-mode, integrity ok. Optionally filter by status.",
    {
      status: z
        .enum(["queued", "running", "done", "failed", "cancelled"])
        .optional()
        .describe("Filter to a single lifecycle status."),
    },
    async ({ status }): Promise<ToolResult> => {
      const rows = lab.list(status ? { status } : undefined);
      return jsonResult({ count: rows.length, experiments: rows });
    },
  );
}
