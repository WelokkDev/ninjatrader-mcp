#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import path from "path";
import { detectWaws } from "../private/waw/detector.js";
import { loadStrategy } from "../private/waw/strategy-loader.js";
import { aggregateCandles } from "../core/aggregator.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import type { Candle, Timeframe } from "../core/types.js";
import type { MarketContext } from "../private/waw/types.js";

const PRODUCTION_TFS: readonly Timeframe[] = ["15m", "30m", "1h", "2h", "4h"];

interface Args {
  file: string;
  tf: string;
  symbol: string;
  minWick: number;
  allowDoji: boolean;
}

function printUsage(): void {
  console.log(
    "usage: test-waw [--file <path>] [--symbol NQ|ES|...] [--tf 1m|5m|15m|30m|1h|2h|4h] " +
      "[--min-wick 0..1] [--allow-doji]",
  );
  console.log("");
  console.log("  --file        path to NT8 export      (default: test-data.txt)");
  console.log("  --symbol      registered symbol       (default: NQ)");
  console.log("  --tf          target timeframe        (default: 4h)");
  console.log("  --min-wick    minWickCoverageOfPriorBody (default: 0)");
  console.log("  --allow-doji  allow doji as c2        (default: false)");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: "test-data.txt",
    tf: "4h",
    symbol: "NQ",
    minWick: 0,
    allowDoji: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else if (a === "--symbol") args.symbol = argv[++i];
    else if (a === "--tf" || a === "--timeframe") args.tf = argv[++i];
    else if (a === "--min-wick") args.minWick = parseFloat(argv[++i]);
    else if (a === "--allow-doji") args.allowDoji = true;
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function tfToMinutes(tf: string): number {
  const m = tf.match(/^(\d+)(m|h)$/);
  if (!m) throw new Error(`bad timeframe "${tf}"`);
  const n = parseInt(m[1]);
  return m[2] === "h" ? n * 60 : n;
}

interface OneMinBar {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// DST-safe wall-clock-to-unix conversion in the given IANA tz. Same
// pattern as src/core/sessions/session-day.ts (intentionally duplicated
// here to keep the script self-contained and avoid leaking a script-only
// helper into the production module surface).
function tzInstantToUnix(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  tz: string,
): number {
  const probeUtcMs = Date.UTC(year, month - 1, day, 12, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(probeUtcMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const localAsUtcMs = Date.UTC(
    +get("year"), +get("month") - 1, +get("day"),
    +get("hour"), +get("minute"), +get("second"),
  );
  const offsetMs = localAsUtcMs - probeUtcMs;
  return Math.floor(
    (Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs) / 1000,
  );
}

// NT8 export format: "YYYYMMDD HHMMSS;O;H;L;C;V" (one row per minute).
// Wall-clock is interpreted in the symbol's session timezone — for NQ
// (CME ETH), that's America/New_York. The printed wall-clock output (also
// in the session tz) matches the input file digits 1:1.
function parseNT8(content: string, tz: string): OneMinBar[] {
  const out: OneMinBar[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = line.split(";");
    if (fields.length < 6) {
      throw new Error(`line ${i + 1}: expected 6 fields, got ${fields.length}`);
    }
    const [tsStr, o, h, l, c, v] = fields;
    const m = tsStr.match(/^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/);
    if (!m) throw new Error(`line ${i + 1}: bad timestamp "${tsStr}"`);
    const [, y, mo, d, hh, mm, ss] = m;
    const ts = tzInstantToUnix(+y, +mo, +d, +hh, +mm, +ss, tz);
    out.push({
      ts,
      o: parseFloat(o),
      h: parseFloat(h),
      l: parseFloat(l),
      c: parseFloat(c),
      v: parseFloat(v),
    });
  }
  return out;
}

// Simple clock-aligned bucketing (UTC). Used to build 15m bars from 1m
// before handing off to the production aggregator, and as a fallback for
// non-production timeframes (1m/5m) that the production aggregator does
// not handle.
function bucket(bars: OneMinBar[], periodMinutes: number): Candle[] {
  const periodSec = periodMinutes * 60;
  const buckets = new Map<number, OneMinBar[]>();
  for (const b of bars) {
    const start = Math.floor(b.ts / periodSec) * periodSec;
    let arr = buckets.get(start);
    if (!arr) {
      arr = [];
      buckets.set(start, arr);
    }
    arr.push(b);
  }
  const out: Candle[] = [];
  for (const group of buckets.values()) {
    group.sort((a, b) => a.ts - b.ts);
    out.push({
      timestamp: group[group.length - 1].ts,
      open: group[0].o,
      high: Math.max(...group.map((g) => g.h)),
      low: Math.min(...group.map((g) => g.l)),
      close: group[group.length - 1].c,
      volume: group.reduce((s, g) => s + g.v, 0),
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function fmtWallClock(epochSec: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(epochSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function isoToEpoch(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function main(): void {
  const args = parseArgs(process.argv);
  const filePath = path.isAbsolute(args.file)
    ? args.file
    : path.resolve(process.cwd(), args.file);

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const config = getInstrumentConfig(args.symbol);
  const sessionTz = config.session.timezone;

  const content = readFileSync(filePath, "utf-8");
  const ones = parseNT8(content, sessionTz);
  if (ones.length === 0) {
    console.error("No bars parsed from file");
    process.exit(1);
  }

  let candles: Candle[];
  const targetMin = tfToMinutes(args.tf);
  if (args.tf === "1m") {
    candles = ones.map((b) => ({
      timestamp: b.ts,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  } else if (PRODUCTION_TFS.includes(args.tf as Timeframe)) {
    // Production path: 1m → 15m (clock-aligned), then 15m → target via
    // the production aggregator (session-aware).
    const fifteens = bucket(ones, 15);
    candles =
      args.tf === "15m"
        ? fifteens
        : aggregateCandles(fifteens, args.tf as Timeframe, {
            session: config.session,
            alignment: config.alignment,
            timestampConvention: config.timestampConvention,
          });
  } else {
    // Custom TF (e.g. 5m): simple clock-aligned bucketing, no session.
    candles = bucket(ones, targetMin);
  }

  const strategy = loadStrategy({
    name: "isolation-test",
    detection: {
      allowDojiAsCandle2: args.allowDoji,
      minWickCoverageOfPriorBody: args.minWick,
    },
    quantifiers: [{ name: "autoAccept", enabled: true, config: {} }],
  });

  const ctx: MarketContext = {
    candles,
    symbol: args.symbol,
    timeframe: args.tf,
  };

  const zones = detectWaws(candles, ctx, strategy);

  const range =
    candles.length > 0
      ? `${fmtWallClock(candles[0].timestamp, sessionTz)} -> ${fmtWallClock(candles[candles.length - 1].timestamp, sessionTz)}`
      : "(empty)";

  const relPath = path.relative(process.cwd(), filePath) || filePath;
  console.log(`File:       ${relPath}`);
  console.log(`Symbol:     ${args.symbol} (session=${config.session.name}, tz=${sessionTz})`);
  console.log(`1m bars:    ${ones.length}`);
  console.log(`Candles:    ${candles.length} @ ${args.tf}`);
  console.log(`Range:      ${range}`);
  console.log(
    `Detection:  minWickCoverageOfPriorBody=${args.minWick}, allowDojiAsCandle2=${args.allowDoji}`,
  );
  console.log(`Zones:      ${zones.length}`);
  console.log("");

  if (zones.length === 0) return;

  const headers = [
    "#",
    "TYPE",
    "C1 TIMESTAMP",
    "C2 TIMESTAMP",
    "PROX",
    "DISTAL",
    "WICK",
    "COV",
  ];
  const rows = zones.map((z, i) => [
    String(i + 1),
    z.type === "demand" ? "DEMAND" : "SUPPLY",
    fmtWallClock(isoToEpoch(z.c1Timestamp), sessionTz),
    fmtWallClock(isoToEpoch(z.c2Timestamp), sessionTz),
    z.proximal.toFixed(2),
    z.distal.toFixed(2),
    z.detectionMeta.wickHeight.toFixed(2),
    z.detectionMeta.coverageRatio.toFixed(2),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log(fmtRow(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmtRow(r));
}

main();
