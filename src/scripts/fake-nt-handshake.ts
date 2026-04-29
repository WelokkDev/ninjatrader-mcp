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
    throw new Error(`NT_BRIDGE_TOKEN not in env and ${envPath} does not exist. Start the MCP once to generate it.`);
  }
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const m = /^NT_BRIDGE_TOKEN\s*=\s*(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  throw new Error(`NT_BRIDGE_TOKEN not found in ${envPath}`);
}

async function main(): Promise<void> {
  const port = process.env.NT_BRIDGE_PORT ?? "9472";
  const token = readToken();
  const url = `ws://127.0.0.1:${port}`;

  console.error(`[fake-nt] connecting to ${url}`);
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const closed = new Promise<void>((resolve, reject) => {
    ws.on("close", (code, reason) => {
      console.error(`[fake-nt] closed (code=${code}, reason=${reason.toString()})`);
      resolve();
    });
    ws.on("error", (err) => {
      console.error(`[fake-nt] error: ${err.message}`);
      reject(err);
    });
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  console.error("[fake-nt] connected");

  ws.on("message", (data) => {
    console.error(`[fake-nt] recv: ${data.toString()}`);
  });

  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      ntVersion: "8.1.4.1",
      instruments: ["ES 03-26", "NQ 03-26", "CL 06-26"],
    }),
  );
  console.error("[fake-nt] sent hello");

  await new Promise((r) => setTimeout(r, 500));

  ws.send(JSON.stringify({ v: 1, type: "heartbeat" }));
  console.error("[fake-nt] sent heartbeat");

  await new Promise((r) => setTimeout(r, 500));

  ws.close(1000, "smoke test done");
  await closed;
}

main().catch((err) => {
  console.error("[fake-nt] fatal:", err);
  process.exit(1);
});
