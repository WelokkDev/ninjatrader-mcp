import type { ExperimentResult } from "./types.js";

export interface MetricDelta {
  a: number;
  b: number;
  delta: number;
}

export interface ResultDiff {
  a: string;
  b: string;
  funnelYes: MetricDelta;
  barsEvaluated: MetricDelta;
  reasonDeltas: Record<string, MetricDelta>;
  perMode: Record<string, Record<string, MetricDelta>>;
  configChanged: boolean;
  /** Honesty note: if config (or engine) changed, funnel deltas are NOT a clean
   *  comparison — yield can move just by loosening a gate. */
  caution?: string;
}

function d(a: number, b: number): MetricDelta {
  return { a, b, delta: b - a };
}

export function diffResults(a: ExperimentResult, b: ExperimentResult): ResultDiff {
  const reasons = new Set([...Object.keys(a.funnel.byReason), ...Object.keys(b.funnel.byReason)]);
  const reasonDeltas: Record<string, MetricDelta> = {};
  for (const r of reasons) {
    reasonDeltas[r] = d(a.funnel.byReason[r] ?? 0, b.funnel.byReason[r] ?? 0);
  }

  const aMode = new Map(a.perMode.map((m) => [m.mode, m]));
  const bMode = new Map(b.perMode.map((m) => [m.mode, m]));
  const modes = new Set([...aMode.keys(), ...bMode.keys()]);
  const perMode: Record<string, Record<string, MetricDelta>> = {};
  for (const mode of modes) {
    const ma = aMode.get(mode);
    const mb = bMode.get(mode);
    perMode[mode] = {
      nTrades: d(ma?.nTrades ?? 0, mb?.nTrades ?? 0),
      winRate: d(ma?.winRate ?? 0, mb?.winRate ?? 0),
      sumR: d(ma?.sumR ?? 0, mb?.sumR ?? 0),
      avgR: d(ma?.avgR ?? 0, mb?.avgR ?? 0),
    };
  }

  const configChanged =
    a.provenance.configHash !== b.provenance.configHash || a.provenance.engine !== b.provenance.engine;

  return {
    a: a.experimentId,
    b: b.experimentId,
    funnelYes: d(a.funnel.yes, b.funnel.yes),
    barsEvaluated: d(a.barsEvaluated, b.barsEvaluated),
    reasonDeltas,
    perMode,
    configChanged,
    caution: configChanged
      ? "config/engine differ — funnel & yield deltas are not a clean A/B; verify the change isn't gate-removal, and judge on faithfulness, not raw count."
      : undefined,
  };
}
