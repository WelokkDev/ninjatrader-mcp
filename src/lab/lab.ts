import os from "node:os";
import { createTracer } from "./obs/tracer.js";
import { memorySink, type MemorySink } from "./obs/sinks.js";
import type { Sink } from "./obs/types.js";
import { systemClock, type Clock } from "./clock.js";
import { newExperimentId } from "./ids.js";
import { EtaCalibrator } from "./eta/calibrator.js";
import { runIntegrity, type IntegrityCheck } from "./integrity/types.js";
import { defaultChecks } from "./integrity/checks.js";
import { diffResults, type ResultDiff } from "./diff.js";
import type { ExperimentStore } from "./store/types.js";
import type { BacktestRunner, RunContext, RunHandle } from "./runner/types.js";
import type {
  ExperimentRecord,
  ExperimentResult,
  ExperimentSpec,
  ExperimentStatus,
  Prediction,
  ProgressUpdate,
} from "./types.js";

const TERMINAL: ExperimentStatus[] = ["done", "failed", "cancelled"];
const isTerminal = (s: ExperimentStatus): boolean => TERMINAL.includes(s);

export interface LabOptions {
  store: ExperimentStore;
  runner: BacktestRunner;
  /** Global sinks every run streams to (console, jsonl, Datadog, …). */
  sinks?: Sink[];
  clock?: Clock;
  calibrator?: EtaCalibrator;
  integrityChecks?: IntegrityCheck[];
  /** Cap on concurrently-running experiments. Default os.cpus()-2. */
  maxConcurrent?: number;
  /** Optional per-experiment sink factory (e.g. a jsonl file per run). */
  perExperimentSink?: (id: string) => Sink | undefined;
  /** If set, ETA calibration is saved here after each completion. */
  calibrationPath?: string;
}

export interface StartResult {
  experimentId: string;
  etaSecs: number | null;
  etaText: string;
  cold: boolean;
  queued: boolean;
}

export interface StatusView {
  id: string;
  status: ExperimentStatus;
  label?: string;
  phase?: string;
  unitsDone?: number;
  unitsTotal?: number;
  pct: number | null;
  etaSecs?: number | null;
  etaText: string;
  runId?: string;
  error?: string;
  prediction?: Prediction;
  recentEvents?: Array<{ name: string; ts: number; attrs: Record<string, unknown> }>;
}

export interface LabSummary {
  id: string;
  status: ExperimentStatus;
  label?: string;
  symbol: string;
  engine?: string;
  createdAt: number;
  finishedAt?: number;
  yes?: number;
  tradesByMode?: Record<string, number>;
  etaSecs?: number | null;
  integrityOk?: boolean;
  error?: string;
}

function humanizeEta(secs: number | null | undefined, cold: boolean): string {
  if (secs == null) return "unknown";
  const m = secs / 60;
  const base = m < 1 ? `${Math.round(secs)}s` : m < 90 ? `~${Math.round(m)}m` : `~${(m / 60).toFixed(1)}h`;
  return cold ? `${base} (cold estimate — could be very off)` : base;
}

/**
 * The Lab — the orchestrator that turns "run this" into an observed, ETA'd,
 * integrity-checked, queryable experiment. It owns lifecycle + concurrency; the
 * engine plugs in as a BacktestRunner, observability flows to your Sinks.
 */
export class Lab {
  private readonly store: ExperimentStore;
  private readonly runner: BacktestRunner;
  private readonly globalSinks: Sink[];
  private readonly clock: Clock;
  private readonly calibrator: EtaCalibrator;
  private readonly checks: IntegrityCheck[];
  private readonly maxConcurrent: number;
  private readonly perExperimentSink?: (id: string) => Sink | undefined;
  private readonly calibrationPath?: string;

  private readonly memSinks = new Map<string, MemorySink>();
  private readonly extSinks = new Map<string, Sink>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly waiters = new Map<string, Array<(rec: ExperimentRecord) => void>>();

  constructor(opts: LabOptions) {
    this.store = opts.store;
    this.runner = opts.runner;
    this.globalSinks = opts.sinks ?? [];
    this.clock = opts.clock ?? systemClock;
    this.calibrator = opts.calibrator ?? new EtaCalibrator();
    this.checks = opts.integrityChecks ?? defaultChecks;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? os.cpus().length - 2);
    this.perExperimentSink = opts.perExperimentSink;
    this.calibrationPath = opts.calibrationPath;
  }

  /** Recover after a restart: orphan in-flight runs, resume the queue. */
  reconcile(): void {
    for (const rec of this.store.list({ status: "running" })) {
      this.store.update(rec.id, {
        status: "failed",
        error: "orphaned (lab restarted while running)",
        finishedAt: this.clock.now(),
      });
    }
    this.pump();
  }

  private key(spec: ExperimentSpec): string {
    return `${this.runner.name}:${spec.engine ?? "default"}`;
  }

  /** Enqueue an experiment; returns immediately with an id + launch-time ETA. */
  async start(spec: ExperimentSpec): Promise<StartResult> {
    const id = newExperimentId();
    const now = this.clock.now();
    let units: number | null = null;
    if (this.runner.estimateUnits) {
      try {
        units = await this.runner.estimateUnits(spec);
      } catch {
        units = null;
      }
    }
    const est = this.calibrator.estimate(this.key(spec), units ?? 0);
    const etaSecs = units == null ? null : est.secs;
    const rec: ExperimentRecord = {
      id,
      status: "queued",
      runner: this.runner.name,
      spec,
      createdAt: now,
      unitsTotal: units ?? undefined,
      etaSecs,
    };
    this.store.create(rec);
    const running = this.store.list({ status: "running" }).length;
    this.pump();
    return {
      experimentId: id,
      etaSecs,
      etaText: humanizeEta(etaSecs, est.cold),
      cold: est.cold,
      queued: running >= this.maxConcurrent,
    };
  }

  private pump(): void {
    let running = this.store.list({ status: "running" }).length;
    if (running >= this.maxConcurrent) return;
    // Oldest queued first (store lists newest-first → reverse).
    const queued = this.store.list({ status: "queued" }).reverse();
    for (const rec of queued) {
      if (running >= this.maxConcurrent) break;
      this.launch(rec);
      running++;
    }
  }

  private launch(rec: ExperimentRecord): void {
    const startedAt = this.clock.now();
    const memSink = memorySink({ capacity: 200, name: "mem" });
    this.memSinks.set(rec.id, memSink);
    const sinks: Sink[] = [...this.globalSinks, memSink];
    const ext = this.perExperimentSink?.(rec.id);
    if (ext) {
      sinks.push(ext);
      this.extSinks.set(rec.id, ext);
    }
    const tracer = createTracer({
      traceId: rec.id,
      clock: this.clock,
      baseAttrs: { experimentId: rec.id, runner: this.runner.name, symbol: rec.spec.symbol },
      sinks,
    });

    // Synchronous → cap accounting in pump() stays correct.
    this.store.update(rec.id, { status: "running", startedAt, heartbeatAt: startedAt });
    tracer.event("experiment.started", { engine: rec.spec.engine ?? "default", label: rec.spec.label });

    const ctx: RunContext = {
      experimentId: rec.id,
      spec: rec.spec,
      tracer,
      progress: (p) => this.onProgress(rec.id, startedAt, p),
      complete: (result) => this.onTerminal(rec.id, tracer, result, null),
      fail: (err) => this.onTerminal(rec.id, tracer, null, err),
    };

    Promise.resolve()
      .then(() => this.runner.start(ctx))
      .then((handle) => {
        this.handles.set(rec.id, handle);
        if (handle.pid != null) this.store.update(rec.id, { pid: handle.pid });
      })
      .catch((e) => this.onTerminal(rec.id, tracer, null, `runner.start failed: ${String(e)}`));
  }

  private onProgress(id: string, startedAt: number, p: ProgressUpdate): void {
    const now = this.clock.now();
    let etaSecs: number | null | undefined = p.etaSecs;
    if (etaSecs == null) {
      if (p.unitsDone > 0 && p.unitsTotal > 0) {
        const msPerUnit = (now - startedAt) / p.unitsDone;
        etaSecs = (msPerUnit * Math.max(0, p.unitsTotal - p.unitsDone)) / 1000;
      } else {
        etaSecs = this.store.get(id)?.etaSecs ?? null;
      }
    }
    this.store.update(id, {
      unitsDone: p.unitsDone,
      unitsTotal: p.unitsTotal,
      phase: p.phase,
      etaSecs,
      heartbeatAt: now,
    });
  }

  private onTerminal(
    id: string,
    tracer: ReturnType<typeof createTracer>,
    result: ExperimentResult | null,
    error: string | null,
  ): void {
    const rec = this.store.get(id);
    if (!rec || isTerminal(rec.status)) return; // guard double-terminal
    const finishedAt = this.clock.now();

    if (result) {
      const report = runIntegrity(result, this.checks);
      result.integrity = report;
      const blockers = report.verdicts.filter((v) => !v.passed && v.severity === "blocker");
      const status: ExperimentStatus = report.ok ? "done" : "failed";
      this.store.update(id, {
        status,
        result,
        finishedAt,
        runId: result.provenance.runId,
        outDir: result.provenance.outDir,
        unitsDone: rec.unitsTotal,
        error: report.ok ? undefined : `integrity: ${blockers.map((b) => b.detail).join("; ")}`,
      });
      // Feed the ETA model (use real engine mode if reported).
      const engine = result.provenance.engine ?? rec.spec.engine ?? "default";
      const msPerUnit =
        result.timing.msPerUnit ??
        (result.barsEvaluated > 0 ? result.timing.wallClockMs / result.barsEvaluated : undefined);
      if (msPerUnit) {
        this.calibrator.record(`${this.runner.name}:${engine}`, msPerUnit);
        if (this.calibrationPath) {
          try {
            this.calibrator.saveFile(this.calibrationPath);
          } catch {
            /* non-fatal */
          }
        }
      }
      tracer.event(report.ok ? "experiment.completed" : "experiment.failed", {
        yes: result.funnel.yes,
        bars: result.barsEvaluated,
        integrityOk: report.ok,
      });
    } else {
      this.store.update(id, { status: "failed", error: error ?? "unknown error", finishedAt });
      tracer.event("experiment.failed", { error: error ?? "unknown" });
    }

    this.disposeSinks(id);
    this.resolveWaiters(id);
    this.pump();
  }

  private disposeSinks(id: string): void {
    const ext = this.extSinks.get(id);
    if (ext) {
      void ext.close?.();
      this.extSinks.delete(id);
    }
    this.memSinks.delete(id);
    this.handles.delete(id);
  }

  private resolveWaiters(id: string): void {
    const rec = this.store.get(id);
    const arr = this.waiters.get(id);
    if (arr && rec) {
      for (const fn of arr) fn(rec);
    }
    this.waiters.delete(id);
  }

  /** Resolve when the experiment reaches a terminal state. */
  waitFor(id: string): Promise<ExperimentRecord> {
    const rec = this.store.get(id);
    if (rec && isTerminal(rec.status)) return Promise.resolve(rec);
    return new Promise((resolve) => {
      const arr = this.waiters.get(id) ?? [];
      arr.push(resolve);
      this.waiters.set(id, arr);
    });
  }

  status(id: string): StatusView | undefined {
    const rec = this.store.get(id);
    if (!rec) return undefined;
    const pct =
      rec.unitsTotal && rec.unitsTotal > 0 && rec.unitsDone != null
        ? Math.round((100 * rec.unitsDone) / rec.unitsTotal)
        : null;
    const recent = this.memSinks
      .get(id)
      ?.records()
      .filter((r) => r.kind === "event")
      .slice(-5)
      .map((r) => ({ name: r.name, ts: r.ts, attrs: r.attrs as Record<string, unknown> }));
    return {
      id: rec.id,
      status: rec.status,
      label: rec.spec.label,
      phase: rec.phase,
      unitsDone: rec.unitsDone,
      unitsTotal: rec.unitsTotal,
      pct,
      etaSecs: rec.etaSecs,
      etaText: humanizeEta(rec.etaSecs, false),
      runId: rec.runId,
      error: rec.error,
      prediction: rec.spec.prediction,
      recentEvents: recent,
    };
  }

  result(id: string): ExperimentResult | undefined {
    return this.store.get(id)?.result;
  }

  list(filter?: { status?: ExperimentStatus }): LabSummary[] {
    return this.store.list(filter).map((rec) => ({
      id: rec.id,
      status: rec.status,
      label: rec.spec.label,
      symbol: rec.spec.symbol,
      engine: rec.spec.engine,
      createdAt: rec.createdAt,
      finishedAt: rec.finishedAt,
      yes: rec.result?.funnel.yes,
      tradesByMode: rec.result
        ? Object.fromEntries(rec.result.perMode.map((m) => [m.mode, m.nTrades]))
        : undefined,
      etaSecs: rec.etaSecs,
      integrityOk: rec.result?.integrity?.ok,
      error: rec.error,
    }));
  }

  diff(idA: string, idB: string): ResultDiff {
    const a = this.store.get(idA)?.result;
    const b = this.store.get(idB)?.result;
    if (!a) throw new Error(`experiment ${idA} has no result`);
    if (!b) throw new Error(`experiment ${idB} has no result`);
    return diffResults(a, b);
  }
}
