import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapBundle, findBundleDir } from "../map-bundle.js";

function writeBundle(dir: string, over: { summary?: object; funnel?: object } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      runId: "run-1",
      symbol: "NQ",
      barsEvaluated: 100,
      decisionsYes: 2,
      perMode: [{ mode: "fixed", nTrades: 1, wins: 0, losses: 1, winRate: 0, sumR: -1, avgR: -1 }],
      engine: "observe",
      fiveMBarsLoaded: 15000,
      wallClockMs: 60000,
      gitShaPrivate: "abc123",
      gitDirtyPrivate: false,
      ...over.summary,
    }),
  );
  writeFileSync(
    path.join(dir, "funnel.json"),
    JSON.stringify({ yes: 2, byReason: { "rr-too-low": 5 }, byStep: {}, ...over.funnel }),
  );
}

describe("ninjatrader adapter: mapBundle", () => {
  it("maps a bundle to the generic ExperimentResult", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lab-bundle-"));
    writeBundle(dir);
    const result = mapBundle(dir, "exp1", { privateShaIntended: "abc123", ntDataPath: "/data" });

    expect(result.symbol).toBe("NQ");
    expect(result.barsEvaluated).toBe(100);
    expect(result.funnel.yes).toBe(2);
    expect(result.funnel.byReason["rr-too-low"]).toBe(5);
    expect(result.perMode[0]!.mode).toBe("fixed");
    expect(result.provenance.privateShaObserved).toBe("abc123");
    expect(result.provenance.privateShaIntended).toBe("abc123");
    expect(result.signals?.barsLoaded).toBe(15000);
    expect(result.signals?.cacheMiss).toBe(false);
    expect(result.timing.msPerUnit).toBe(600); // 60000 / 100
  });

  it("flags a cache miss when zero bars loaded (the false-0 trap)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lab-bundle-"));
    writeBundle(dir, { summary: { fiveMBarsLoaded: 0 } });
    const result = mapBundle(dir, "exp1");
    expect(result.signals?.cacheMiss).toBe(true);
  });

  it("findBundleDir discovers the runId subdir", () => {
    const out = mkdtempSync(path.join(os.tmpdir(), "lab-out-"));
    const sub = path.join(out, "run-uuid");
    writeBundle(sub);
    expect(findBundleDir(out)).toBe(sub);
  });
});
