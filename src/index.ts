#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "./db/connection.js";
import { registerGenericTools, startRuntime, stopRuntime } from "./server.js";

// The public MCP server: every generic tool, no private module required.
// Experiment tools are runner-gated (they need a Lab bound to a backtest
// engine) and are registered by private bins instead — see BUILD-YOUR-OWN.md
// for composing your own server on top of this surface.

const server = new McpServer({
  name: "ninjatrader-mcp",
  version: "0.1.0",
});

registerGenericTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NinjaTrader MCP server running");

  await startRuntime();
}

const shutdown = async (signal: string) => {
  console.error(`Received ${signal}, shutting down`);
  await stopRuntime();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
