#!/usr/bin/env node

import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "../db/connection.js";
import { ingestCandles } from "../bridge/ingest.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import type { Candle } from "../core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sampleDir = path.join(__dirname, "..", "..", "data", "sample");

function parseCsv(content: string): Candle[] {
  const lines = content.trim().split("\n");
  return lines.slice(1).map((line) => {
    const [timestamp, open, high, low, close, volume] = line.split(",");
    return {
      timestamp: parseInt(timestamp),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    };
  });
}

function main() {
  const files = readdirSync(sampleDir).filter((f) => f.endsWith("_15m.csv"));

  if (files.length === 0) {
    console.error("No *_15m.csv files found in", sampleDir);
    process.exit(1);
  }

  let totalDropped = 0;
  for (const file of files) {
    const symbol = file.replace("_15m.csv", "");
    // Throws if the symbol isn't registered. Fail loudly rather than
    // silently aggregating with the wrong session model.
    getInstrumentConfig(symbol);

    const content = readFileSync(path.join(sampleDir, file), "utf-8");
    const candles = parseCsv(content);

    // Route through the single owner of candle persistence: session
    // filtering, derived recomputation, and day-refill convergence all come
    // from ingest. Note re-seeding an existing DB converges CSV-touched
    // closed days rather than being purely additive.
    const result = ingestCandles(symbol, "15m", candles, db, { mode: "day-refill" });
    totalDropped += result.dropped;
    console.error(
      `${symbol} 15m: ${result.inserted} inserted, ${result.dropped} dropped (invalid, out-of-session, or off-grid); derived: ${JSON.stringify(result.aggregated)}`,
    );
  }

  if (totalDropped > 0) {
    console.error(
      `WARNING: ${totalDropped} CSV row(s) were dropped — see the per-row messages above. ` +
        `Check that stamps are close-stamped unix seconds within the instrument's session ` +
        `(open-stamped exports put every bar one slot early and the session-open bar out of session).`,
    );
  }
  console.error("Seed complete.");
}

main();
