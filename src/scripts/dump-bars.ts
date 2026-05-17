#!/usr/bin/env node
// Dump cached candles for a symbol/session-day range so aggregation can be
// verified against NT8 charts. All timestamps print in ET (NT8 convention).
//
// Usage:
//   npm run dump-bars -- NQ 2026-05-01
//   npm run dump-bars -- NQ 2026-04-30 2026-05-01
//   npm run dump-bars -- NQ 2026-05-01 2026-05-01 15m,1h
//
// Args: <symbol> <startDay> [endDay] [timeframes-csv]
//   - startDay/endDay are session-days (YYYY-MM-DD) in ET (NQ ETH = 18:00 prev → 17:00 same)
//   - timeframes default to: 5m,15m,30m,1h,2h,4h

import db from "../db/connection.js";
import { formatExchangeTime } from "../core/time.js";

const [, , symbolArg, startArg, endArgRaw, tfArgRaw] = process.argv;

if (!symbolArg || !startArg) {
  console.error("Usage: dump-bars <symbol> <startDay YYYY-MM-DD> [endDay] [tf,tf,...]");
  console.error("Example: npm run dump-bars -- NQ 2026-05-01");
  process.exit(1);
}

const symbol = symbolArg.toUpperCase();
const endArg = endArgRaw ?? startArg;
const timeframes = (tfArgRaw ?? "5m,15m,30m,1h,2h,4h").split(",").map((s) => s.trim());

// Session-day → ETH window (Sun-Fri 18:00 ET → 17:00 ET next day).
// For dump purposes this is "best-effort": treat the day in ET as 18:00 prev → 17:00 same.
function sessionWindowSec(day: string): { startSec: number; endSec: number } {
  const [y, m, d] = day.split("-").map(Number);
  // Build the ET-local moments by using a known formula:
  //   start = (day-1) 18:00 ET   end = day 17:00 ET
  // Construct UTC anchor then offset using DST-aware formatter probe.
  const probeStart = Date.UTC(y, m - 1, d - 1, 22, 0, 0); // assume EDT (UTC-4) initially
  const probeEnd = Date.UTC(y, m - 1, d, 21, 0, 0);

  // Adjust if DST disagrees: format as ET hour and shift by ±1h until it lands on 18 / 17.
  const fmtHour = (ms: number) =>
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        hour12: false,
      }).format(new Date(ms))
    );

  let startMs = probeStart;
  for (let i = 0; i < 3 && fmtHour(startMs) !== 18; i++) startMs += 3600_000;
  let endMs = probeEnd;
  for (let i = 0; i < 3 && fmtHour(endMs) !== 17; i++) endMs += 3600_000;

  return { startSec: Math.floor(startMs / 1000), endSec: Math.floor(endMs / 1000) };
}

const { startSec } = sessionWindowSec(startArg);
const { endSec } = sessionWindowSec(endArg);

console.log(`Symbol:     ${symbol}`);
console.log(`Sessions:   ${startArg} → ${endArg}`);
console.log(`Window:     ${formatExchangeTime(startSec)} ET  →  ${formatExchangeTime(endSec)} ET`);
console.log(`Timeframes: ${timeframes.join(", ")}\n`);

const stmt = db.prepare(`
  SELECT timestamp, open, high, low, close, volume
  FROM candles
  WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
  ORDER BY timestamp ASC
`);

for (const tf of timeframes) {
  const rows = stmt.all(symbol, tf, startSec, endSec) as Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;

  console.log(`========== ${symbol} ${tf}  (${rows.length} bars) ==========`);
  for (const r of rows) {
    console.log(
      `${formatExchangeTime(r.timestamp)} ET   ` +
        `O:${r.open.toFixed(2)}  H:${r.high.toFixed(2)}  L:${r.low.toFixed(2)}  C:${r.close.toFixed(2)}  V:${r.volume}`
    );
  }
  console.log();
}
