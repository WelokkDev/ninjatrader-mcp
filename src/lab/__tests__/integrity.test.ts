import { describe, it, expect } from "vitest";
import { causalCheck, cacheCheck, provenanceCheck } from "../integrity/checks.js";
import { runIntegrity } from "../integrity/types.js";
import { defaultChecks } from "../integrity/checks.js";
import type { ExperimentResult } from "../types.js";

function baseResult(over: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    experimentId: "e",
    runner: "fake",
    symbol: "NQ",
    barsEvaluated: 100,
    funnel: { yes: 1, byReason: {} },
    perMode: [],
    provenance: { engine: "observe", privateShaIntended: "aaaa", privateShaObserved: "aaaa" },
    signals: { barsLoaded: 100, causality: { entriesChecked: 1, violations: 0 } },
    timing: { wallClockMs: 1000, msPerUnit: 10 },
    ...over,
  };
}

describe("integrity: causal", () => {
  it("passes with zero violations", () => {
    expect(causalCheck(baseResult()).passed).toBe(true);
  });
  it("BLOCKS on a look-ahead violation", () => {
    const v = causalCheck(baseResult({ signals: { causality: { entriesChecked: 3, violations: 1 } } }));
    expect(v.passed).toBe(false);
    expect(v.severity).toBe("blocker");
  });
  it("warns (does not block) when the runner reports no causality data", () => {
    const v = causalCheck(baseResult({ signals: { barsLoaded: 100 } }));
    expect(v.passed).toBe(false);
    expect(v.severity).toBe("warn");
  });
});

describe("integrity: cache", () => {
  it("BLOCKS on zero bars (the false-0 trap)", () => {
    const v = cacheCheck(baseResult({ barsEvaluated: 0, signals: { barsLoaded: 0 } }));
    expect(v.passed).toBe(false);
    expect(v.severity).toBe("blocker");
  });
  it("BLOCKS when the runner flags a cache miss", () => {
    expect(cacheCheck(baseResult({ signals: { cacheMiss: true } })).passed).toBe(false);
  });
});

describe("integrity: provenance", () => {
  it("BLOCKS when intended != observed engine SHA", () => {
    const v = provenanceCheck(
      baseResult({ provenance: { privateShaIntended: "aaaa", privateShaObserved: "bbbb" } }),
    );
    expect(v.passed).toBe(false);
    expect(v.severity).toBe("blocker");
  });
  it("warns on a dirty tree but does not block", () => {
    const v = provenanceCheck(baseResult({ provenance: { gitDirtyPrivate: true } }));
    expect(v.passed).toBe(true);
    expect(v.severity).toBe("warn");
  });
});

describe("runIntegrity", () => {
  it("ok=true when only warnings fail", () => {
    const report = runIntegrity(baseResult({ signals: { barsLoaded: 100 } }), defaultChecks);
    expect(report.ok).toBe(true); // causal-not-reported is a warn
  });
  it("ok=false when any blocker fails", () => {
    const report = runIntegrity(
      baseResult({ signals: { barsLoaded: 100, causality: { entriesChecked: 2, violations: 2 } } }),
      defaultChecks,
    );
    expect(report.ok).toBe(false);
  });
});
