import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register log_trade tool.
 * Writes to the SQLite trades table, auto-computes R-multiple
 * from entry/stop/target.
 */
export function registerLogTrade(_server: McpServer): void {
  // erm...
}
