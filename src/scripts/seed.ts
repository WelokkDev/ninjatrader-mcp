#!/usr/bin/env node

import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "../db/connection.js";
import { aggregateCandles } from "../core/aggregator.js";
import { SUPPORTED_TIMEFRAMES } from "../core/constants.js";
import type { Candle, Timeframe } from "../core/types.js";

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

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const file of files) {
    const symbol = file.replace("_15m.csv", "");
    const content = readFileSync(path.join(sampleDir, file), "utf-8");
    const candles = parseCsv(content);

    // Insert 15m candles in a single transaction
    db.transaction(() => {
      for (const c of candles) {
        insertStmt.run(
          symbol, "15m", c.timestamp,
          c.open, c.high, c.low, c.close, c.volume,
        );
      }
    })();
    console.error(`${symbol} 15m: ${candles.length} rows`);

    // Aggregate and insert higher timeframes
    for (const tf of SUPPORTED_TIMEFRAMES) {
      if (tf === "15m") continue;
      const aggregated = aggregateCandles(candles, tf);
      db.transaction(() => {
        for (const c of aggregated) {
          insertStmt.run(
            symbol, tf as Timeframe, c.timestamp,
            c.open, c.high, c.low, c.close, c.volume,
          );
        }
      })();
      console.error(`${symbol} ${tf}: ${aggregated.length} rows`);
    }
  }

  console.error("Seed complete.");
}

main();
