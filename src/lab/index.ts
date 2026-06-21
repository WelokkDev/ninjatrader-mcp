// ─────────────────────────────────────────────────────────────────────────────
// Strategy Lab — public API.
//
// A framework-agnostic backtest research lab: async experiment lifecycle, deep
// observability, ETA, integrity gates. Plug in ANY engine via BacktestRunner;
// stream observability to ANY backend via Sink. See README.md for extraction.
// ─────────────────────────────────────────────────────────────────────────────

// Core orchestrator
export { Lab } from "./lab.js";
export type { LabOptions, StartResult, StatusView, LabSummary } from "./lab.js";

// Domain types
export type {
  ExperimentSpec,
  ExperimentRecord,
  ExperimentResult,
  ExperimentStatus,
  Prediction,
  ProgressUpdate,
  Funnel,
  ModeMetric,
  Provenance,
  IntegritySignals,
  IntegrityReport,
  IntegrityVerdict,
} from "./types.js";

// Observability (the extractable core)
export * from "./obs/index.js";

// Storage
export * from "./store/index.js";

// Runner seam
export * from "./runner/index.js";

// ETA
export * from "./eta/index.js";

// Integrity
export * from "./integrity/index.js";

// Diff
export { diffResults, type ResultDiff, type MetricDelta } from "./diff.js";

// Clock + ids (handy for tests / custom wiring)
export { systemClock, manualClock, type Clock } from "./clock.js";
export { newExperimentId } from "./ids.js";
