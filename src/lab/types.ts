// ─────────────────────────────────────────────────────────────────────────────
// Core lab types — framework-agnostic. Nothing here knows about NinjaTrader
// or any specific engine. A backtest is just: a spec in, progress while
// it runs, a normalized result out. Engines plug in behind BacktestRunner.
// ─────────────────────────────────────────────────────────────────────────────

import type { Attributes } from "./obs/types.js";

export type ExperimentStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** A pre-registered prediction — recorded BEFORE a run so "it worked" can be
 *  scored against "it did what I said it would". Anti-self-deception. */
export interface Prediction {
  hypothesis: string;
  gateUnderTest?: string;
  expected?: Array<{ metric: string; direction: "up" | "down" | "flat"; magnitude?: string }>;
  predictedTradeBand?: [number, number];
}

/** What you ask the lab to run. Generic across engines. */
export interface ExperimentSpec {
  symbol: string;
  startDay: string; // "YYYY-MM-DD"
  endDay: string; // "YYYY-MM-DD"
  engine?: string; // engine mode, e.g. "observe" | "replay"
  modes?: string[]; // management modes
  strategy?: string;
  smaPreset?: string;
  lookbackDays?: number;
  configOverrides?: Record<string, unknown>;
  /** The private-repo branch this variant's engine code lives on (provenance). */
  expBranch?: string;
  /** Skip heavy per-decision artifacts (the giant trace file) for sweep cells. */
  lean?: boolean;
  prediction?: Prediction;
  label?: string;
  /** Free-form passthrough for engine-specific knobs an adapter understands. */
  extra?: Record<string, unknown>;
}

export interface ProgressUpdate {
  unitsDone: number;
  unitsTotal: number;
  phase?: string;
  /** If the runner can compute its own ETA, it may pass it; otherwise the lab derives one. */
  etaSecs?: number | null;
  extra?: Attributes;
}

// ── Normalized result shape (token-tiny; this is what agents read) ────────────

export interface Funnel {
  /** Count of "yes" decisions (setups that passed the whole chain). */
  yes: number;
  /** "no" decisions grouped by the short reason code that killed them. */
  byReason: Record<string, number>;
  byStep?: Record<string, { reached: number; passed: number; failed: number }>;
}

export interface ModeMetric {
  mode: string;
  nTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  sumR: number;
  avgR: number;
}

export interface Provenance {
  gitSha?: string | null;
  gitShaPrivate?: string | null;
  gitDirty?: boolean;
  gitDirtyPrivate?: boolean;
  /** Branch SHA captured at spawn; cross-checked against what actually ran. */
  privateShaIntended?: string | null;
  privateShaObserved?: string | null;
  configHash?: string | null;
  engine?: string;
  runId?: string;
  outDir?: string;
  ntDataPath?: string;
}

/** Engine-reported integrity signals an adapter may populate; the lab's
 *  integrity checks consume these. All optional so any runner can participate. */
export interface IntegritySignals {
  /** Did the runner load any bars? 0 ⇒ the silent cache-miss trap. */
  barsLoaded?: number;
  /** Causal self-checks the engine ran on its own trades/decisions. */
  causality?: { entriesChecked: number; violations: number };
  /** True if the runner detected a required-data cache miss. */
  cacheMiss?: boolean;
}

export interface ExperimentResult {
  experimentId: string;
  runner: string;
  symbol: string;
  barsEvaluated: number;
  funnel: Funnel;
  perMode: ModeMetric[];
  provenance: Provenance;
  signals?: IntegritySignals;
  timing: { wallClockMs: number; msPerUnit?: number };
  /** Filled in by the lab after running integrity checks. */
  integrity?: IntegrityReport;
}

export interface IntegrityVerdict {
  check: string;
  passed: boolean;
  severity: "blocker" | "warn";
  detail: string;
}

export interface IntegrityReport {
  ok: boolean; // false if any blocker failed
  verdicts: IntegrityVerdict[];
}

/** The persisted/queryable record of an experiment through its lifecycle. */
export interface ExperimentRecord {
  id: string;
  status: ExperimentStatus;
  runner: string;
  spec: ExperimentSpec;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  pid?: number;
  heartbeatAt?: number;
  unitsDone?: number;
  unitsTotal?: number;
  etaSecs?: number | null;
  phase?: string;
  runId?: string;
  outDir?: string;
  result?: ExperimentResult;
  error?: string;
}
