import type { IntegrityCheck } from "./types.js";

// These guards encode the project's hard-won lessons so a variant can never
// "win" by cheating. They operate on the generic ExperimentResult; an engine
// participates by populating result.signals / result.provenance.

/**
 * No look-ahead. The runner self-checks that every entry post-dates its
 * decision and every decision read only past bars, and reports the tally.
 * A violation is a BLOCKER — the run is untrustworthy and excluded.
 * If the runner reports nothing, that's a WARN (we can't confirm causality).
 */
export const causalCheck: IntegrityCheck = (result) => {
  const c = result.signals?.causality;
  if (!c) {
    return {
      check: "causal",
      passed: false,
      severity: "warn",
      detail: "runner did not report causality checks — cannot confirm no look-ahead",
    };
  }
  const passed = c.violations === 0;
  return {
    check: "causal",
    passed,
    severity: "blocker",
    detail: passed
      ? `0 causal violations over ${c.entriesChecked} entries`
      : `${c.violations} causal (look-ahead) violation(s) over ${c.entriesChecked} entries`,
  };
};

/**
 * No silent cache-miss. A run that evaluated 0 bars (or whose runner flagged a
 * data gap) produces a clean-looking 0-trade result that is indistinguishable
 * from a real decline — the original "zero-trades" trap. BLOCKER.
 */
export const cacheCheck: IntegrityCheck = (result) => {
  if (result.signals?.cacheMiss) {
    return { check: "cache", passed: false, severity: "blocker", detail: "runner flagged a data cache miss" };
  }
  const loaded = result.signals?.barsLoaded ?? result.barsEvaluated;
  const passed = (loaded ?? 0) > 0;
  return {
    check: "cache",
    passed,
    severity: "blocker",
    detail: passed ? `${loaded} bars present` : "0 bars loaded/evaluated — likely empty or wrong data",
  };
};

/**
 * Provenance honesty. The engine that ran must match the branch it claims, and
 * dirty (uncommitted) runs are reproducibility hazards.
 *  - intended != observed private SHA ⇒ BLOCKER (ran the wrong engine).
 *  - dirty private tree ⇒ WARN (recorded, but not reproducible from SHA alone).
 */
export const provenanceCheck: IntegrityCheck = (result) => {
  const p = result.provenance;
  if (p.privateShaIntended && p.privateShaObserved && p.privateShaIntended !== p.privateShaObserved) {
    return {
      check: "provenance",
      passed: false,
      severity: "blocker",
      detail: `engine SHA mismatch: intended ${p.privateShaIntended.slice(0, 8)} != observed ${p.privateShaObserved.slice(0, 8)}`,
    };
  }
  if (p.gitDirtyPrivate) {
    return {
      check: "provenance",
      passed: true,
      severity: "warn",
      detail: "ran against an uncommitted (dirty) private tree — not reproducible from SHA alone",
    };
  }
  return { check: "provenance", passed: true, severity: "warn", detail: "provenance clean" };
};

/** The default guard set applied to every run. */
export const defaultChecks: IntegrityCheck[] = [causalCheck, cacheCheck, provenanceCheck];
