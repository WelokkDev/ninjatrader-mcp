import type { ExperimentResult, IntegrityReport, IntegrityVerdict } from "../types.js";

/** A single pluggable guard. Pure: looks at a result, returns a verdict. */
export type IntegrityCheck = (result: ExperimentResult) => IntegrityVerdict;

/** Run a set of checks; ok=false iff any BLOCKER failed (warns never block). */
export function runIntegrity(result: ExperimentResult, checks: IntegrityCheck[]): IntegrityReport {
  const verdicts = checks.map((c) => c(result));
  const ok = verdicts.every((v) => v.passed || v.severity !== "blocker");
  return { ok, verdicts };
}

export type { IntegrityVerdict, IntegrityReport };
