import type {
  ExperimentRecord,
  ExperimentResult,
  Funnel,
  ModeMetric,
  Provenance,
  IntegritySignals,
} from "../types.js";
import type { BacktestRunner, RunContext, RunHandle, RunProbe, CompletedScan } from "./types.js";

// A deterministic in-process runner that simulates a backtest: it emits a few
// progress ticks then a terminal result, scheduled asynchronously so it
// exercises the full lab lifecycle (queueing, progress, ETA, integrity) with no
// engine, no child process, and no real time. Used by the test suite and as a
// living example of how a runner reports to the lab.

export interface FakeRunnerOptions {
  name?: string;
  unitsTotal?: number;
  progressTicks?: number;
  msPerUnit?: number;
  /** If set, the run fails with this message instead of completing. */
  fail?: string;
  funnel?: Partial<Funnel>;
  perMode?: ModeMetric[];
  provenance?: Partial<Provenance>;
  signals?: Partial<IntegritySignals>;
  /** If set, start() does NOT report a terminal result (simulates a detached
   *  child whose exit callback never reached this process). */
  silent?: boolean;
  /** What probe() reports — the durable-state read after a "restart". */
  probeResult?: RunProbe | ((rec: ExperimentRecord) => RunProbe);
  /** Completed bundles scanCompleted() reports — the disk-as-truth adoption feed. */
  scanResult?: CompletedScan[];
}

export class FakeRunner implements BacktestRunner {
  readonly name: string;
  constructor(private readonly opts: FakeRunnerOptions = {}) {
    this.name = opts.name ?? "fake";
  }

  estimateUnits(): number {
    return this.opts.unitsTotal ?? 1000;
  }

  start(ctx: RunContext): RunHandle {
    const total = this.opts.unitsTotal ?? 1000;
    const ticks = Math.max(1, this.opts.progressTicks ?? 4);
    const msPerUnit = this.opts.msPerUnit ?? 5;

    const span = ctx.tracer.startSpan("backtest.walk", { engine: ctx.spec.engine ?? "default" });

    const steps: Array<() => void> = [];
    for (let i = 1; i <= ticks; i++) {
      const unitsDone = Math.round((total * i) / ticks);
      steps.push(() => {
        span.event("bar.progress", { unitsDone, unitsTotal: total });
        span.metric("ms_per_unit", msPerUnit, { unit: "ms" });
        ctx.progress({ unitsDone, unitsTotal: total, phase: "walk" });
      });
    }

    steps.push(() => {
      span.end({ status: this.opts.fail ? "error" : "ok" });
      if (this.opts.silent) return;
      if (this.opts.fail) {
        ctx.fail(this.opts.fail);
        return;
      }
      ctx.complete(this.buildResult(ctx, total, msPerUnit));
    });

    // Drive the steps off the event loop so start() returns first.
    let i = 0;
    const run = (): void => {
      if (i >= steps.length) return;
      steps[i++]!();
      setImmediate(run);
    };
    setImmediate(run);

    return { experimentId: ctx.experimentId };
  }

  probe(rec: ExperimentRecord): RunProbe {
    const p = this.opts.probeResult;
    return typeof p === "function" ? p(rec) : (p ?? { state: "running" });
  }

  scanCompleted(): CompletedScan[] {
    return this.opts.scanResult ?? [];
  }

  private buildResult(ctx: RunContext, total: number, msPerUnit: number): ExperimentResult {
    const yes = this.opts.funnel?.yes ?? 0;
    const funnel: Funnel = {
      yes,
      byReason: this.opts.funnel?.byReason ?? {},
      byStep: this.opts.funnel?.byStep,
    };
    const provenance: Provenance = {
      engine: ctx.spec.engine ?? "default",
      configHash: "fake-confighash",
      privateShaIntended: "fakesha0",
      privateShaObserved: "fakesha0",
      ...this.opts.provenance,
    };
    const signals: IntegritySignals = {
      barsLoaded: total,
      causality: { entriesChecked: yes, violations: 0 },
      ...this.opts.signals,
    };
    return {
      experimentId: ctx.experimentId,
      runner: this.name,
      symbol: ctx.spec.symbol,
      barsEvaluated: total,
      funnel,
      perMode: this.opts.perMode ?? [],
      provenance,
      signals,
      timing: { wallClockMs: total * msPerUnit, msPerUnit },
    };
  }
}
