#!/usr/bin/env node

import "./db/connection.js";
import { announceToolGating, registerGenericTools } from "./server.js";
import { runBin } from "./hub/bin.js";

// The public MCP server: every generic tool, no private module required.
// Experiment tools are runner-gated (they need a Lab bound to a backtest
// engine) and are registered by private bins instead — see BUILD-YOUR-OWN.md
// for composing your own server on top of this surface.

announceToolGating();

runBin({
  name: "ninjatrader-mcp",
  version: "0.1.0",
  compose: (server, session) => registerGenericTools(server, { session }),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
