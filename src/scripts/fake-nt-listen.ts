#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readToken(): string {
  if (process.env.NT_BRIDGE_TOKEN) return process.env.NT_BRIDGE_TOKEN;
  const envPath = path.join(__dirname, "..", "..", ".env.local");
  if (!existsSync(envPath)) {
    throw new Error("no token");
  }
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = /^NT_BRIDGE_TOKEN\s*=\s*(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  throw new Error("no token");
}

async function main(): Promise<void> {
  const port = process.env.NT_BRIDGE_PORT ?? "9472";
  const url = `ws://127.0.0.1:${port}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${readToken()}` },
  });

  ws.on("open", () => {
    console.error("[fake-nt-listen] connected");
    ws.send(JSON.stringify({ v: 1, type: "hello", ntVersion: "8.1.4.1", instruments: ["ES"] }));
    setInterval(() => ws.send(JSON.stringify({ v: 1, type: "heartbeat" })), 10_000);
  });
  ws.on("message", (data) => {
    console.error(`[fake-nt-listen] recv: ${data.toString()}`);
  });
  ws.on("close", (code, reason) => {
    console.error(`[fake-nt-listen] closed (code=${code}, reason=${reason.toString()})`);
    process.exit(0);
  });
  ws.on("error", (err) => {
    console.error(`[fake-nt-listen] error: ${err.message}`);
  });
}

main();
