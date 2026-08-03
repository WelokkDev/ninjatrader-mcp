// Import a Databento OHLCV batch file into the candle cache.
//
// TS owns time/session policy (resolves the file's range into session-days);
// Python owns compute (decodes the .dbn.zst, writes rows with
// source='databento', which classifySessionDay treats as immutable).
//
//   npm run import-databento -- --file D:/candle-data/xyz.dbn.zst --symbol MNQ
//   npm run import-databento -- --file ... --symbol MNQ --dry-run
//
// Stop the MCP server first: it holds candles.db open in WAL mode.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import db from "../db/connection.js";
import { SUPPORTED_SYMBOLS, isRawTimeframe } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDaysOverlapping } from "../core/sessions/session-day.js";
import { loadCalendar } from "../core/sessions/calendar.js";
import type { Timeframe } from "../core/types.js";

// Public-tooling venv — not src/private/py/.venv (public code can't depend on private).
const PYTHON = "./.venv-tools/Scripts/python.exe";
const IMPORTER = "scripts/import-databento.py";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const file = arg("file");
const symbol = arg("symbol");
const timeframe = (arg("timeframe") ?? "1s") as Timeframe;
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

if (!file) fail("--file is required (path to a .dbn.zst batch file)");
if (!symbol) fail(`--symbol is required (one of ${SUPPORTED_SYMBOLS.join(", ")})`);
if (!SUPPORTED_SYMBOLS.includes(symbol)) {
  fail(`Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`);
}
// Derived timeframes are recomputed from raw bars — importing one directly
// would just be overwritten by the next recompute.
if (!isRawTimeframe(timeframe)) {
  fail(`--timeframe ${timeframe} is derived, not raw. Import a raw timeframe.`);
}

// Ask the file what range it covers, rather than making the operator restate it.
const probe = spawnSync(PYTHON, [IMPORTER, "--print-range", "--file", file], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  fail(`Could not read ${file}:\n${probe.stderr || probe.stdout}`);
}
const range = JSON.parse(probe.stdout) as {
  dataset: string;
  schema: string;
  startUnix: number;
  endUnix: number;
};

const config = getInstrumentConfig(symbol);
const template = config.session;
const calendar = loadCalendar(db, template.name);
const days = sessionDaysOverlapping(range.startUnix, range.endUnix, template, calendar);

if (days.length === 0) fail(`No ${template.name} session-days overlap the file's range.`);

console.log(`file      ${file}`);
console.log(`dataset   ${range.dataset} ${range.schema}`);
console.log(`target    ${symbol} ${timeframe}  (template ${template.name})`);
console.log(
  `sessions  ${days.length} session-days, ${days[0].label} .. ${days[days.length - 1].label}` +
    (calendar.size > 0 ? ` (${calendar.size} calendar exceptions applied)` : " (calendar-blind)"),
);

const handoff = join(mkdtempSync(join(tmpdir(), "dbn-import-")), "session-days.json");
writeFileSync(
  handoff,
  JSON.stringify(
    days.map((d) => ({ label: d.label, startUnix: d.startUnix, endUnix: d.endUnix })),
  ),
);

const run = spawnSync(
  PYTHON,
  [
    IMPORTER,
    "--file", file,
    "--session-days", handoff,
    "--db", db.name,
    "--symbol", symbol,
    "--timeframe", timeframe,
    ...(dryRun ? ["--dry-run"] : []),
    ...(force ? ["--force"] : []),
  ],
  { stdio: "inherit" },
);
process.exit(run.status ?? 1);
