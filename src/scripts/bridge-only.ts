#!/usr/bin/env node

import { randomUUID } from "crypto";
import { createInterface } from "readline";
import {
  startBridge,
  stopBridge,
  getBridgeStatus,
  onMessage,
  send,
} from "../bridge/index.js";

function printHelp(): void {
  console.error(
    [
      "",
      "commands:",
      "  draw <symbol> <proximal> <distal> [id]   send a draw_zone",
      "  clear <symbol> [id]                       send a clear_zones (no id = clear all)",
      "  status                                     print connection status",
      "  help                                       show this",
      "  quit                                       shut down",
      "",
    ].join("\n"),
  );
}

function handleLine(line: string): boolean {
  const parts = line.trim().split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) return true;
  const cmd = parts[0].toLowerCase();

  if (cmd === "quit" || cmd === "exit") return false;

  if (cmd === "help" || cmd === "?") {
    printHelp();
    return true;
  }

  if (cmd === "status") {
    console.error(JSON.stringify(getBridgeStatus(), null, 2));
    return true;
  }

  if (cmd === "draw") {
    const [, symbol, proxStr, distStr, maybeId] = parts;
    if (!symbol || !proxStr || !distStr) {
      console.error("usage: draw <symbol> <proximal> <distal> [id]");
      return true;
    }
    const proximal = parseFloat(proxStr);
    const distal = parseFloat(distStr);
    if (isNaN(proximal) || isNaN(distal)) {
      console.error("proximal and distal must be numbers");
      return true;
    }
    const id = maybeId ?? randomUUID();
    const ok = send({ v: 1, type: "draw_zone", id, symbol, proximal, distal });
    console.error(ok ? `[stdin] sent draw_zone id=${id}` : "[stdin] no client connected");
    return true;
  }

  if (cmd === "clear") {
    const [, symbol, maybeId] = parts;
    if (!symbol) {
      console.error("usage: clear <symbol> [id]");
      return true;
    }
    const ok = send({ v: 1, type: "clear_zones", symbol, ...(maybeId ? { id: maybeId } : {}) });
    console.error(ok ? `[stdin] sent clear_zones${maybeId ? ` id=${maybeId}` : " (all)"}` : "[stdin] no client connected");
    return true;
  }

  console.error(`unknown command: ${cmd} (try 'help')`);
  return true;
}

async function main(): Promise<void> {
  await startBridge();

  onMessage("hello", (msg) => {
    console.error(`[bridge-only] hello: nt=${msg.ntVersion}, instruments=[${msg.instruments.join(", ")}]`);
  });
  onMessage("heartbeat", () => {
    // quiet — too noisy at 10s
  });

  printHelp();

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  rl.on("line", (line) => {
    const keepGoing = handleLine(line);
    if (!keepGoing) {
      rl.close();
    }
  });
  rl.on("close", async () => {
    await stopBridge();
    process.exit(0);
  });
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
