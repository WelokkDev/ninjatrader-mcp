import type { Tracer } from "../obs/types.js";
import type { ExperimentRecord, ExperimentResult, ExperimentSpec, ProgressUpdate } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// The adapter seam. ANY backtest engine becomes lab-compatible by implementing
// BacktestRunner. It can run in-process, in a child process, or on a remote box
// — the lab only cares that it reports progress and a terminal result via the
// RunContext it's handed. This is the single interface your friend implements.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunHandle {
  experimentId: string;
  pid?: number;
  cancel?(): void | Promise<void>;
}

export interface RunContext {
  readonly experimentId: string;
  readonly spec: ExperimentSpec;
  /** Pre-wired with the experiment id / runner / symbol as base attributes. */
  readonly tracer: Tracer;
  /** Report progress; the lab persists it and derives a live ETA. */
  progress(update: ProgressUpdate): void;
  /** Terminal success. The lab runs integrity checks and stamps the verdict. */
  complete(result: ExperimentResult): void;
  /** Terminal failure with a human-readable reason. */
  fail(error: string): void;
}

/** Durable-state read of a run, derived from disk + process liveness — NOT
 *  from parent memory. Lets the lab recover/triage runs after a restart. */
export interface RunProbe {
  state: "running" | "completed" | "failed";
  /** Present iff completed: the mapped bundle, ready for integrity checks. */
  result?: ExperimentResult;
  /** Human-readable reason when failed. */
  detail?: string;
}

/** A completed run discovered on durable storage by scanCompleted(), used to
 *  adopt bundles whose store row is missing or was wrongly orphaned. */
export interface CompletedScan {
  id: string;
  result: ExperimentResult;
  /** The original spec, when recoverable from durable run metadata. */
  spec?: ExperimentSpec;
}

export interface BacktestRunner {
  readonly name: string;
  /** Cheap up-front unit count (e.g. bars to walk) for a launch-time ETA. */
  estimateUnits?(spec: ExperimentSpec): number | null | Promise<number | null>;
  /** Begin a run; resolve once LAUNCHED. Report terminal state via ctx. */
  start(ctx: RunContext): RunHandle | Promise<RunHandle>;
  /** Re-derive a run's terminal state from durable artifacts after a restart.
   *  May be async (e.g. a remote runner querying job state). Optional: runners
   *  without it fall back to orphan-on-reconcile. */
  probe?(rec: ExperimentRecord): RunProbe | Promise<RunProbe>;
  /** Scan durable storage for completed runs, so the lab can adopt bundles whose
   *  store row is missing or stale — this is what makes disk the source of truth
   *  for completion, not lab.db. Optional. */
  scanCompleted?(): CompletedScan[] | Promise<CompletedScan[]>;
}
