#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "./db/connection.js";
import { startBridge, stopBridge } from "./bridge/index.js";
import {
  registerCandlesResponseHandler,
  registerLiveIngestHandler,
} from "./bridge/ingest.js";
import { registerCalendarSyncOnHello } from "./bridge/calendar-sync.js";

import { registerGetCandles } from "./tools/get-candles.js";
import { registerResolveSessionDays } from "./tools/resolve-session-days.js";
import { registerPrefetchTools } from "./tools/prefetch-candles.js";
import { registerScanZones } from "./tools/scan-zones.js";
import { registerDrawZone } from "./tools/draw-zone.js";
import { registerDraw } from "./tools/draw.js";
import { registerClearZones } from "./tools/clear-zones.js";
import { registerGetPlayingField } from "./tools/get-playing-field.js";
import { registerScanForTrade } from "./tools/scan-for-trade.js";
import { registerRunBacktest } from "./tools/run-backtest.js";
import { registerListTrades } from "./tools/list-trades.js";
import { registerListDecisions } from "./tools/list-decisions.js";
import { registerGetTrades, registerSyncTrades } from "./tools/get-trades.js";
import { registerStartExperiment } from "./tools/start-experiment.js";
import { registerExperimentStatus } from "./tools/experiment-status.js";
import { registerExperimentResult } from "./tools/experiment-result.js";
import { registerListExperiments } from "./tools/list-experiments.js";
import { registerDiffExperiments } from "./tools/diff-experiments.js";
// import { registerLogTrade } from "./tools/log-trade.js";

const server = new McpServer({
  name: "ninjatrader-mcp",
  version: "0.1.0",
});

registerGetCandles(server);
registerResolveSessionDays(server);
registerPrefetchTools(server);
registerScanZones(server);
registerDrawZone(server);
registerDraw(server);
registerClearZones(server);
registerGetPlayingField(server);
registerScanForTrade(server);
registerRunBacktest(server);
registerListTrades(server);
registerListDecisions(server);
registerGetTrades(server);
registerSyncTrades(server);

// Strategy Lab — async experiment orchestration + observability.
registerStartExperiment(server);
registerExperimentStatus(server);
registerExperimentResult(server);
registerListExperiments(server);
registerDiffExperiments(server);
// registerLogTrade(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NinjaTrader MCP server running");

  await startBridge();
  registerLiveIngestHandler();
  registerCandlesResponseHandler();
  registerCalendarSyncOnHello();
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
