// ─────────────────────────────────────────────────────────────────────────────
// Strategy Lab — public API.
//
// A framework-agnostic backtest research lab: async experiment lifecycle, deep
// observability, ETA, integrity gates. Plug in ANY engine via BacktestRunner;
// stream observability to ANY backend via Sink. See README.md for extraction.
// ─────────────────────────────────────────────────────────────────────────────

export { Lab } from "./lab.js";
export type { LabOptions, StartResult, StatusView, LabSummary } from "./lab.js";

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

export * from "./store/index.js";
export * from "./runner/index.js";
export * from "./eta/index.js";
export * from "./integrity/index.js";
export { diffResults, type ResultDiff, type MetricDelta } from "./diff.js";

// Clock + ids (handy for tests / custom wiring)
export { systemClock, manualClock, type Clock } from "./clock.js";
export { newExperimentId } from "./ids.js";
