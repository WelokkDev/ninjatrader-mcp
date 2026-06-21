import type { Tracer } from "../obs/types.js";
import type { ExperimentResult, ExperimentSpec, ProgressUpdate } from "../types.js";

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

export interface BacktestRunner {
  readonly name: string;
  /** Cheap up-front unit count (e.g. bars to walk) for a launch-time ETA. */
  estimateUnits?(spec: ExperimentSpec): number | null | Promise<number | null>;
  /** Begin a run; resolve once LAUNCHED. Report terminal state via ctx. */
  start(ctx: RunContext): RunHandle | Promise<RunHandle>;
}
