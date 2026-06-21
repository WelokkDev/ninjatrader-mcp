import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { BacktestRunner, RunContext, RunHandle } from "../../lab/runner/types.js";
import type { ExperimentSpec } from "../../lab/types.js";
import { findBundleDir, mapBundle } from "./map-bundle.js";

// ─────────────────────────────────────────────────────────────────────────────
// The NinjaTrader adapter. Implements the lab's BacktestRunner by
// spawning the existing run-backtest-observable script as a DETACHED child
// (a real run is ~100 min — it cannot block the MCP process), then mapping the
// on-disk bundle to the lab's generic ExperimentResult on exit.
//
// Live per-bar progress lights up automatically once the runner emits a
// progress.json (a small runner edit); until then the lab reports
// queued → running → done/failed with launch-time + calibrated ETA. The adapter
// is the ONLY place that knows about the private engine, and it touches it by
// spawning a path string — it imports nothing private.
// ─────────────────────────────────────────────────────────────────────────────

export interface NinjaTraderRunnerOptions {
  /** Repo root (cwd for the child; where build/ lives). */
  repoRoot: string;
  /** Defaults to <repoRoot>/build/private/scripts/run-backtest-observable.js */
  scriptPath?: string;
  /** Defaults to <repoRoot>/backtest-results */
  resultsRoot?: string;
  /** NT_DATA_PATH propagated to the child so it reads the SAME candles.db. */
  dataPath?: string;
  nodeBin?: string;
  pollMs?: number;
  /** Optional: resolve the intended private-branch SHA for provenance cross-check. */
  privateShaResolver?: (spec: ExperimentSpec) => string | null;
}

function readJsonSafe(file: string): any | undefined {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

export class NinjaTraderRunner implements BacktestRunner {
  readonly name = "ninjatrader";
  private readonly repoRoot: string;
  private readonly scriptPath: string;
  private readonly resultsRoot: string;
  private readonly dataPath: string;
  private readonly nodeBin: string;
  private readonly pollMs: number;

  constructor(private readonly opts: NinjaTraderRunnerOptions) {
    this.repoRoot = opts.repoRoot;
    this.scriptPath =
      opts.scriptPath ?? path.join(opts.repoRoot, "build/private/scripts/run-backtest-observable.js");
    this.resultsRoot = opts.resultsRoot ?? path.join(opts.repoRoot, "backtest-results");
    this.dataPath = opts.dataPath ?? process.env.NT_DATA_PATH ?? path.join(opts.repoRoot, "data");
    this.nodeBin = opts.nodeBin ?? "node";
    this.pollMs = opts.pollMs ?? 2000;
  }

  start(ctx: RunContext): RunHandle {
    const spec = ctx.spec;
    const outDir = path.join(this.resultsRoot, ctx.experimentId);
    mkdirSync(outDir, { recursive: true });

    const args: string[] = [this.scriptPath, spec.symbol, spec.startDay, spec.endDay];
    if (spec.engine) args.push(`--engine=${spec.engine}`);
    if (spec.modes?.length) args.push(`--modes=${spec.modes.join(",")}`);
    if (spec.strategy) args.push(`--strategy=${spec.strategy}`);
    if (spec.smaPreset) args.push(`--sma-preset=${spec.smaPreset}`);
    if (spec.lookbackDays != null) args.push(`--lookback-days=${spec.lookbackDays}`);
    if (spec.configOverrides) args.push(`--config-overrides=${JSON.stringify(spec.configOverrides)}`);
    if (spec.lean) args.push("--lean");
    args.push(`--out=${outDir}`, `--experiment-id=${ctx.experimentId}`);

    const intendedSha = this.opts.privateShaResolver?.(spec) ?? null;
    const logFd = openSync(path.join(outDir, "runner.log"), "a");

    const child = spawn(this.nodeBin, args, {
      cwd: this.repoRoot,
      env: { ...process.env, NT_DATA_PATH: this.dataPath },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    ctx.tracer.event("runner.spawned", { pid: child.pid ?? -1, outDir });
    child.unref();

    let settled = false;
    const poll = setInterval(() => {
      const bundleDir = findBundleDir(outDir);
      if (!bundleDir) return;
      const p = readJsonSafe(path.join(bundleDir, "progress.json"));
      if (p && typeof p.barsDone === "number" && typeof p.barsTotal === "number") {
        ctx.progress({
          unitsDone: p.barsDone,
          unitsTotal: p.barsTotal,
          phase: p.phase,
          etaSecs: typeof p.etaSecs === "number" ? p.etaSecs : null,
        });
      }
    }, this.pollMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
      fn();
    };

    child.on("error", (err) => finish(() => ctx.fail(`spawn error: ${String(err)}`)));
    child.on("exit", (code) => {
      const bundleDir = findBundleDir(outDir);
      if (code === 0 && bundleDir) {
        finish(() =>
          ctx.complete(
            mapBundle(bundleDir, ctx.experimentId, {
              privateShaIntended: intendedSha,
              ntDataPath: this.dataPath,
            }),
          ),
        );
      } else {
        finish(() =>
          ctx.fail(`runner exited code ${code ?? "?"}${bundleDir ? "" : " (no bundle produced)"}`),
        );
      }
    });

    return {
      experimentId: ctx.experimentId,
      pid: child.pid,
      cancel: () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      },
    };
  }
}
