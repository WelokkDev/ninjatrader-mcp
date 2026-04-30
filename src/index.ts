#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "./db/connection.js";
import { startBridge, stopBridge } from "./bridge/index.js";
import { registerLiveIngestHandler } from "./bridge/ingest.js";

import { registerGetCandles } from "./tools/get-candles.js";
// import { registerScanZones } from "./tools/scan-zones.js";
// import { registerDrawZone } from "./tools/draw-zone.js";
// import { registerClearZones } from "./tools/clear-zones.js";
// import { registerLogTrade } from "./tools/log-trade.js";

const server = new McpServer({
  name: "ninjatrader-mcp",
  version: "0.1.0",
});

registerGetCandles(server);
// registerScanZones(server);
// registerDrawZone(server);
// registerClearZones(server);
// registerLogTrade(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NinjaTrader MCP server running");

  await startBridge();
  registerLiveIngestHandler();
}

const shutdown = async (signal: string) => {
  console.error(`Received ${signal}, shutting down`);
  await stopBridge();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
