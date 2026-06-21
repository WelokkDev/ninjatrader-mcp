import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ExperimentResult, Funnel, ModeMetric, Provenance } from "../../lab/types.js";

// Maps the run-backtest-observable bundle (summary.json / funnel.json /
// provenance.json / result.json) into the lab's generic ExperimentResult.
// Defensive: every field is optional-read so a partial/old bundle still maps.

function readJson(file: string): any | undefined {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The runner mints its own runId and writes the bundle into <outDir>/<runId>/.
 *  Find that subdir (newest with a summary.json). */
export function findBundleDir(outDir: string): string | undefined {
  if (!existsSync(outDir)) return undefined;
  // The bundle might be written directly to outDir, or one level down.
  if (existsSync(path.join(outDir, "summary.json"))) return outDir;
  let best: { dir: string; mtime: number } | undefined;
  for (const entry of readdirSync(outDir)) {
    const dir = path.join(outDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(path.join(dir, "summary.json"))) continue;
      const m = statSync(dir).mtimeMs;
      if (!best || m > best.mtime) best = { dir, mtime: m };
    } catch {
      /* skip */
    }
  }
  return best?.dir;
}

export function mapBundle(
  bundleDir: string,
  experimentId: string,
  opts: { privateShaIntended?: string | null; ntDataPath?: string } = {},
): ExperimentResult {
  const summary = readJson(path.join(bundleDir, "summary.json")) ?? {};
  const funnelRaw = readJson(path.join(bundleDir, "funnel.json")) ?? {};
  const result = readJson(path.join(bundleDir, "result.json")); // present once the runner edit lands
  const provFile = readJson(path.join(bundleDir, "provenance.json")) ?? {};

  const funnel: Funnel = {
    yes: funnelRaw.yes ?? summary.decisionsYes ?? 0,
    byReason: funnelRaw.byReason ?? {},
    byStep: funnelRaw.byStep,
  };

  const perMode: ModeMetric[] = Array.isArray(summary.perMode)
    ? summary.perMode.map((m: any) => ({
        mode: String(m.mode),
        nTrades: m.nTrades ?? 0,
        wins: m.wins ?? 0,
        losses: m.losses ?? 0,
        winRate: m.winRate ?? 0,
        sumR: m.sumR ?? 0,
        avgR: m.avgR ?? 0,
      }))
    : [];

  const barsEvaluated = summary.barsEvaluated ?? 0;
  const fiveM = summary.fiveMBarsLoaded;
  const wallClockMs = summary.wallClockMs ?? 0;

  const provenance: Provenance = {
    gitSha: summary.gitSha ?? provFile.gitSha ?? null,
    gitShaPrivate: summary.gitShaPrivate ?? provFile.gitShaPrivate ?? null,
    gitDirty: summary.gitDirty ?? provFile.gitDirty,
    gitDirtyPrivate: summary.gitDirtyPrivate ?? provFile.gitDirtyPrivate,
    privateShaIntended: opts.privateShaIntended ?? null,
    privateShaObserved: summary.gitShaPrivate ?? provFile.gitShaPrivate ?? null,
    configHash: result?.configHash ?? null,
    engine: summary.engine,
    runId: summary.runId,
    outDir: bundleDir,
    ntDataPath: opts.ntDataPath,
  };

  return {
    experimentId,
    runner: "ninjatrader",
    symbol: summary.symbol ?? "",
    barsEvaluated,
    funnel,
    perMode,
    provenance,
    signals: {
      barsLoaded: fiveM,
      // Populated once the runner emits causalityChecks into result.json.
      causality: result?.causalityChecks,
      cacheMiss: fiveM === 0,
    },
    timing: {
      wallClockMs,
      msPerUnit: barsEvaluated > 0 ? wallClockMs / barsEvaluated : undefined,
    },
  };
}
