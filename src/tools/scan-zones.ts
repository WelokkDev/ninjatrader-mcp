import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register scan_zones tool.
 * Wraps the zone detection engine, calls get_candles across multiple
 * timeframes, scores zones against the rubric, returns ranked results.
 */
export function registerScanZones(_server: McpServer): void {
  // ............
}
