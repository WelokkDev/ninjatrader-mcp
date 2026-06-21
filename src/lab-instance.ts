import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { Lab } from "./lab/lab.js";
import { SqliteExperimentStore, openLabDatabase } from "./lab/store/sqlite-store.js";
import { EtaCalibrator } from "./lab/eta/calibrator.js";
import { consoleSink, jsonlSink } from "./lab/obs/sinks.js";
import { NinjaTraderRunner } from "./adapters/ninjatrader/index.js";

// The single Lab instance the MCP server exposes. This is the one place the
// generic lab is bound to THIS project's engine + storage. Swap the runner or
// store here (or stand up a second Lab) without touching the tools.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, ".."); // build/ -> repo root at runtime
const dataDir = process.env.NT_DATA_PATH
  ? path.resolve(process.env.NT_DATA_PATH)
  : path.join(repoRoot, "data");
const calibrationPath = path.join(dataDir, "lab-calibration.json");

function resolvePrivateSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: path.join(repoRoot, "src", "private"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const store = new SqliteExperimentStore(openLabDatabase(path.join(dataDir, "lab.db")));
const runner = new NinjaTraderRunner({
  repoRoot,
  dataPath: dataDir,
  privateShaResolver: () => resolvePrivateSha(),
});

export const lab = new Lab({
  store,
  runner,
  calibrator: EtaCalibrator.fromFile(calibrationPath),
  calibrationPath,
  // Global sink: human-readable lifecycle to stderr (stdout stays clean for MCP).
  sinks: [consoleSink()],
  // Per-experiment: a full event trace on disk next to the bundle.
  perExperimentSink: (id) => jsonlSink(path.join(repoRoot, "backtest-results", id, "events.jsonl")),
});

// Recover any runs orphaned by a previous server crash, resume the queue.
lab.reconcile();
