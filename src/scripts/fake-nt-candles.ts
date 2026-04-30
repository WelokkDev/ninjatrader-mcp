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
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = /^NT_BRIDGE_TOKEN\s*=\s*(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  throw new Error(`NT_BRIDGE_TOKEN not found in ${envPath}`);
}

const FIFTEEN_MIN = 15 * 60;

function buildFakeCandles(from: number, to: number, count: number) {
  const span = Math.max(1, to - from);
  const step = Math.max(FIFTEEN_MIN, Math.floor(span / count));
  const out = [];
  let price = 20_000;
  for (let i = 0; i < count; i++) {
    const ts = from + i * step;
    const open = price;
    const close = open + (Math.random() - 0.5) * 10;
    const high = Math.max(open, close) + Math.random() * 5;
    const low = Math.min(open, close) - Math.random() * 5;
    out.push({
      timestamp: ts,
      open,
      high,
      low,
      close,
      volume: Math.floor(1000 + Math.random() * 2000),
    });
    price = close;
  }
  return out;
}

async function main(): Promise<void> {
  const port = process.env.NT_BRIDGE_PORT ?? "9472";
  const token = readToken();
  const url = `ws://127.0.0.1:${port}`;

  console.error(`[fake-nt-candles] connecting to ${url}`);
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  ws.on("open", () => {
    console.error("[fake-nt-candles] connected");
    ws.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        ntVersion: "8.1.4.1",
        instruments: ["ES 03-26", "NQ 03-26", "MNQ 03-26"],
      }),
    );
    console.error("[fake-nt-candles] sent hello");

    setTimeout(() => {
      ws.send(JSON.stringify({ v: 1, type: "heartbeat" }));
      console.error("[fake-nt-candles] sent heartbeat");
    }, 500);

    setInterval(() => {
      try {
        ws.send(JSON.stringify({ v: 1, type: "heartbeat" }));
      } catch {
        // ignore
      }
    }, 10_000);
  });

  ws.on("message", (data) => {
    const raw = data.toString();
    console.error(`[fake-nt-candles] recv: ${raw}`);

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "request_candles") {
      const id = String(msg.id);
      const symbol = String(msg.symbol);
      const timeframe = String(msg.timeframe);
      const from = Number(msg.from);
      const to = Number(msg.to);
      const candles = buildFakeCandles(from, to, 5);
      const response = {
        v: 1,
        id,
        type: "candles_response",
        symbol,
        timeframe,
        candles,
      };
      ws.send(JSON.stringify(response));
      console.error(
        `[fake-nt-candles] sent candles_response id=${id} symbol=${symbol} tf=${timeframe} count=${candles.length}`,
      );
    }
  });

  ws.on("close", (code, reason) => {
    console.error(`[fake-nt-candles] closed (code=${code}, reason=${reason.toString()})`);
    process.exit(0);
  });
  ws.on("error", (err) => {
    console.error(`[fake-nt-candles] error: ${err.message}`);
  });
}

main().catch((err) => {
  console.error("[fake-nt-candles] fatal:", err);
  process.exit(1);
});
