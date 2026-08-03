// Cross-check imported bars against an independently-sourced coarser timeframe.
//
// Aggregates a fine raw TF up to a coarse raw TF NT8 fetched directly, and
// diffs them — catching stamp-convention errors that throw nothing (e.g. an
// off-by-one-period import silently shifts every bar into the future).
//
// --shift is the falsification test: re-runs the comparison with fine stamps
// moved N seconds, so the chosen convention has to beat its neighbours.
//
//   npm run verify-import -- --symbol MNQ --fine 1s --coarse 5m
//   npm run verify-import -- --symbol MNQ --fine 1s --coarse 5m --shift -1
//
// OHLC comparison is exact (both feeds quote a tick grid). Volume is
// informational only — vendors count trades differently.

import db from "../db/connection.js";
import { SUPPORTED_SYMBOLS, isRawTimeframe } from "../core/constants.js";
import { formatExchangeTime } from "../core/time.js";
import type { Timeframe } from "../core/types.js";

const PERIOD: Record<string, number> = {
  "1s": 1, "5s": 5, "15s": 15, "5m": 300, "15m": 900,
  "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const symbol = arg("symbol") ?? fail("--symbol is required");
const fine = (arg("fine") ?? "1s") as Timeframe;
const coarse = (arg("coarse") ?? "5m") as Timeframe;
const shift = Number(arg("shift") ?? 0);

if (!SUPPORTED_SYMBOLS.includes(symbol)) fail(`Unsupported symbol: ${symbol}`);
if (!isRawTimeframe(fine) || !isRawTimeframe(coarse)) {
  fail(`Both --fine and --coarse must be RAW timeframes (a derived one is aggregated, not fetched, so agreement would prove nothing).`);
}
if (!(PERIOD[fine] < PERIOD[coarse])) fail(`--fine must be shorter than --coarse`);

const period = PERIOD[coarse];

interface Agg { o: number; h: number; l: number; c: number; v: number; first: number; last: number }

// Close-stamped bucketing: a coarse bar stamped T covers fine stamps in
// (T - period, T], so T = ceil(t / period) * period.
const bucketOf = (t: number): number => Math.ceil(t / period) * period;

console.log(`verifying ${symbol}: ${fine} aggregated -> ${coarse}` + (shift ? `  [shift ${shift >= 0 ? "+" : ""}${shift}s]` : ""));

const buckets = new Map<number, Agg>();
const fineRows = db
  .prepare(
    `SELECT timestamp, open, high, low, close, volume FROM candles
      WHERE symbol = ? AND timeframe = ? ORDER BY timestamp`,
  )
  .iterate(symbol, fine) as Iterable<{
    timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  }>;

let fineCount = 0;
for (const r of fineRows) {
  fineCount++;
  const t = r.timestamp + shift;
  const b = bucketOf(t);
  const a = buckets.get(b);
  if (a === undefined) {
    buckets.set(b, { o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, first: t, last: t });
    continue;
  }
  if (r.high > a.h) a.h = r.high;
  if (r.low < a.l) a.l = r.low;
  a.v += r.volume;
  if (t < a.first) { a.first = t; a.o = r.open; }
  if (t > a.last) { a.last = t; a.c = r.close; }
}

if (fineCount === 0) fail(`No ${fine} rows cached for ${symbol}.`);
console.log(`aggregated ${fineCount.toLocaleString()} ${fine} rows into ${buckets.size.toLocaleString()} ${coarse} buckets\n`);

// Compare only against NT8-sourced coarse bars — comparing an import to itself
// would prove nothing.
const coarseRows = db
  .prepare(
    `SELECT timestamp, open, high, low, close, volume FROM candles
      WHERE symbol = ? AND timeframe = ? AND COALESCE(source,'nt8') = 'nt8'
      ORDER BY timestamp`,
  )
  .all(symbol, coarse) as Array<{
    timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  }>;

let compared = 0, ohlcMatch = 0, closeMatch = 0, volMatch = 0, noCover = 0;
const perDay = new Map<string, { n: number; ok: number }>();
const worst: Array<{ t: number; field: string; got: number; want: number }> = [];

for (const c of coarseRows) {
  const a = buckets.get(c.timestamp);
  if (a === undefined) { noCover++; continue; }
  compared++;
  const day = formatExchangeTime(c.timestamp).slice(0, 10);
  const d = perDay.get(day) ?? { n: 0, ok: 0 };
  d.n++;

  const okO = a.o === c.open, okH = a.h === c.high, okL = a.l === c.low, okC = a.c === c.close;
  if (okC) closeMatch++;
  if (okO && okH && okL && okC) { ohlcMatch++; d.ok++; }
  else if (worst.length < 12) {
    const f = !okO ? ["open", a.o, c.open] : !okH ? ["high", a.h, c.high]
      : !okL ? ["low", a.l, c.low] : ["close", a.c, c.close];
    worst.push({ t: c.timestamp, field: f[0] as string, got: f[1] as number, want: f[2] as number });
  }
  if (Math.abs(a.v - c.volume) < 1e-9) volMatch++;
  perDay.set(day, d);
}

const pct = (n: number): string => `${((n / compared) * 100).toFixed(3)}%`;
console.log(`compared      ${compared.toLocaleString()} ${coarse} bars (NT8-sourced)`);
console.log(`  OHLC exact  ${ohlcMatch.toLocaleString()}  ${pct(ohlcMatch)}`);
console.log(`  close exact ${closeMatch.toLocaleString()}  ${pct(closeMatch)}`);
console.log(`  volume eq   ${volMatch.toLocaleString()}  ${pct(volMatch)}   (informational — feeds count trades differently)`);
if (noCover > 0) console.log(`  uncovered   ${noCover.toLocaleString()} ${coarse} bars had no ${fine} data (outside the imported range)`);

// Days that disagree wholesale are the contract-roll signature — NT8 and the
// importer rolled on different days.
const badDays = [...perDay.entries()].filter(([, d]) => d.ok / d.n < 0.5).sort();
if (badDays.length > 0) {
  console.log(`\n${badDays.length} day(s) below 50% agreement — check these against the roll schedule:`);
  for (const [day, d] of badDays.slice(0, 15)) {
    console.log(`  ${day}  ${d.ok}/${d.n}  (${((d.ok / d.n) * 100).toFixed(1)}%)`);
  }
}

if (worst.length > 0) {
  console.log(`\nfirst ${worst.length} mismatch(es):`);
  for (const w of worst) {
    console.log(`  ${formatExchangeTime(w.t)}  ${w.field}: aggregated ${w.got} vs cached ${w.want}  (Δ ${(w.got - w.want).toFixed(2)})`);
  }
}
