import { spawn } from "node:child_process";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import type {
  BacktestRunner,
  RunContext,
  RunHandle,
  RunProbe,
  CompletedScan,
} from "../../lab/runner/types.js";
import type { ExperimentRecord, ExperimentResult, ExperimentSpec } from "../../lab/types.js";
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
  /** Data preflight, run before anything is spawned or written. Return a
   *  refusal message to fail the run instantly, or null to proceed.
   *  Injected so the adapter stays free of DB knowledge. */
  preflight?: (spec: ExperimentSpec) => string | null;
}

function readJsonSafe(file: string): any | undefined {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/** Liveness check for a possibly-detached child by pid. process.kill(pid, 0)
 *  sends no signal — it only tests existence. ESRCH ⇒ gone; EPERM ⇒ alive but
 *  not ours (still alive). Interim signal until the engine emits a heartbeat. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** A bundle is "complete" only if it actually parsed into a usable result. A
 *  torn summary.json (read mid-write) fails to parse → empty symbol; a real run
 *  always has a symbol — even a degenerate 0-bar window, which is a valid result
 *  integrity will flag, not a not-yet-written file. Validate on symbol, NOT
 *  barsEvaluated (a 0-bar run is complete, just empty). */
function isCompleteBundle(r: ExperimentResult): boolean {
  return r.symbol.length > 0;
}

function readMetaPid(outDir: string): number | null {
  const meta = readJsonSafe(path.join(outDir, "run-meta.json"));
  return typeof meta?.pid === "number" ? meta.pid : null;
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

    // A detached run must never launch on dates that don't resolve or a
    // cache that's missing bars — the child would walk partial data to a
    // plausible verdict.
    const preflightError = this.opts.preflight?.(spec) ?? null;
    if (preflightError) {
      ctx.tracer.event("runner.preflight_failed", { reason: preflightError });
      ctx.fail(`data preflight failed: ${preflightError}`);
      return { experimentId: ctx.experimentId };
    }

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

    // Make the run dir self-describing (spec + pid on disk) so recovery never
    // depends on in-memory state: probe reads pid here, scanCompleted reads spec.
    try {
      writeFileSync(
        path.join(outDir, "run-meta.json"),
        JSON.stringify(
          { experimentId: ctx.experimentId, pid: child.pid ?? null, startedAt: Date.now(), spec },
          null,
          2,
        ),
      );
    } catch {
      /* non-fatal: probe falls back to the store's pid */
    }

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

  /** Re-derive a run's true state from durable artifacts after a restart:
   *  a completed bundle on disk ⇒ completed (mapped); else a live pid ⇒ running;
   *  else ⇒ failed. The run dir is the source of truth, not parent memory. */
  probe(rec: ExperimentRecord): RunProbe {
    const outDir = path.join(this.resultsRoot, rec.id);
    const bundleDir = findBundleDir(outDir);
    if (bundleDir) {
      const result = mapBundle(bundleDir, rec.id, {
        privateShaIntended: this.opts.privateShaResolver?.(rec.spec) ?? null,
        ntDataPath: this.dataPath,
      });
      if (isCompleteBundle(result)) return { state: "completed", result };
      // summary.json exists but didn't map to a usable result — a torn/partial
      // read while the child is still writing. Fall through to liveness; NEVER
      // declare terminal from a possibly-incomplete read.
    }
    const pid = readMetaPid(outDir) ?? rec.pid ?? null;
    if (pid != null && isAlive(pid)) return { state: "running" };
    if (pid != null) return { state: "failed", detail: `no usable bundle; pid ${pid} not alive` };
    // No pid known. If the run dir exists, the child was launched but we lost its
    // pid — treat as running (a later tick / the max-age fail-safe resolves it)
    // rather than destroy a possibly-live run on uncertainty.
    if (existsSync(outDir)) return { state: "running" };
    return { state: "failed", detail: "no run directory — never launched" };
  }

  /** Disk-as-truth scan: every run dir holding a complete, mappable bundle. The
   *  lab adopts these against its store (recovering rows lost or wrongly orphaned).
   *  `spec` comes from run-meta.json, so only lab-launched runs carry it — foreign
   *  / pre-lab bundles are returned without a spec and the lab ignores them. */
  scanCompleted(): CompletedScan[] {
    const out: CompletedScan[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.resultsRoot);
    } catch {
      return out;
    }
    for (const name of entries) {
      const outDir = path.join(this.resultsRoot, name);
      try {
        if (!statSync(outDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const bundleDir = findBundleDir(outDir);
      if (!bundleDir) continue;
      const meta = readJsonSafe(path.join(outDir, "run-meta.json"));
      const result = mapBundle(bundleDir, name, {
        // Resolve the intended SHA (as the probe path does) so adopted runs still
        // get the provenance mismatch blocker — don't hardcode null.
        privateShaIntended: meta?.spec ? (this.opts.privateShaResolver?.(meta.spec) ?? null) : null,
        ntDataPath: this.dataPath,
      });
      if (!isCompleteBundle(result)) continue;
      out.push({ id: name, result, spec: meta?.spec });
    }
    return out;
  }
}
