#!/usr/bin/env node

import { startBridge, stopBridge, getBridgeStatus, onMessage } from "../bridge/index.js";

async function main(): Promise<void> {
  await startBridge();

  onMessage("hello", (msg) => {
    console.error(`[bridge-only] hello handler fired: nt=${msg.ntVersion}, instruments=${msg.instruments.join(",")}`);
  });
  onMessage("heartbeat", () => {
    console.error("[bridge-only] heartbeat handler fired");
  });

  setInterval(() => {
    const s = getBridgeStatus();
    console.error(`[bridge-only] status: ${JSON.stringify(s)}`);
  }, 2_000);
}

const shutdown = async () => {
  await stopBridge();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err) => {
  console.error("[bridge-only] fatal:", err);
  process.exit(1);
});
