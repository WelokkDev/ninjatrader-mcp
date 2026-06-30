import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NinjaTraderRunner } from "../runner.js";
import type { ExperimentRecord } from "../../../lab/types.js";

// Exercises the REAL disk-truth path: bundle presence and pid liveness, with
// real temp files — not a canned probe result. This is the risky half of the
// durability fix, so it gets its own coverage.

const rec = (id: string, pid?: number): ExperimentRecord => ({
  id,
  status: "running",
  runner: "ninjatrader",
  spec: { symbol: "NQ", startDay: "2026-04-01", endDay: "2026-05-01" },
  createdAt: 1,
  pid,
});

describe("NinjaTraderRunner.probe (disk truth)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "lab-probe-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runner = (): NinjaTraderRunner =>
    new NinjaTraderRunner({ repoRoot: root, resultsRoot: root });

  it("reports completed and maps the bundle when summary.json exists", () => {
    const dir = path.join(root, "exp1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({ symbol: "NQ", barsEvaluated: 100, fiveMBarsLoaded: 100, perMode: [], runId: "r1" }),
    );
    const p = runner().probe(rec("exp1"));
    expect(p.state).toBe("completed");
    expect(p.result?.symbol).toBe("NQ");
    expect(p.result?.barsEvaluated).toBe(100);
  });

  it("reports running when there is no bundle but the pid is alive", () => {
    // Our own process is, by definition, alive.
    const p = runner().probe(rec("exp2", process.pid));
    expect(p.state).toBe("running");
  });

  it("reports failed when there is no bundle and the pid is dead", () => {
    const p = runner().probe(rec("exp3", 999999));
    expect(p.state).toBe("failed");
    expect(p.detail).toMatch(/bundle/);
  });

  it("reports failed when there is no bundle and no pid was ever captured", () => {
    const p = runner().probe(rec("exp4", undefined));
    expect(p.state).toBe("failed");
  });

  it("does NOT report completed for a torn/incomplete summary.json; fails when pid is dead", () => {
    const dir = path.join(root, "exp5");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "summary.json"), "{ this is not valid json");
    const p = runner().probe(rec("exp5", 999999));
    expect(p.state).not.toBe("completed");
    expect(p.state).toBe("failed");
  });

  it("treats a torn bundle with a live process as still running (revisitable, not terminal)", () => {
    const dir = path.join(root, "exp6");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "summary.json"), "{ torn write in progress");
    const p = runner().probe(rec("exp6", process.pid));
    expect(p.state).toBe("running");
  });

  it("scanCompleted returns only complete bundles, with spec from run-meta.json", () => {
    const a = path.join(root, "expA");
    mkdirSync(a, { recursive: true });
    writeFileSync(
      path.join(a, "summary.json"),
      JSON.stringify({ symbol: "NQ", barsEvaluated: 10, fiveMBarsLoaded: 10, perMode: [] }),
    );
    writeFileSync(
      path.join(a, "run-meta.json"),
      JSON.stringify({ spec: { symbol: "NQ", startDay: "2026-04-01", endDay: "2026-05-01" } }),
    );
    const b = path.join(root, "expB"); // torn → excluded
    mkdirSync(b, { recursive: true });
    writeFileSync(path.join(b, "summary.json"), "{ torn");
    const c = path.join(root, "expC"); // no bundle → excluded
    mkdirSync(c, { recursive: true });

    const scans = runner().scanCompleted();
    const ids = scans.map((s) => s.id);
    expect(ids).toContain("expA");
    expect(ids).not.toContain("expB");
    expect(ids).not.toContain("expC");
    expect(scans.find((s) => s.id === "expA")?.spec?.startDay).toBe("2026-04-01");
  });

  // #4 — a complete but 0-bar (empty-window) run is a real, degenerate result,
  // not a torn read. probe must return it as completed (and let integrity flag
  // the 0 bars), NOT fall through to a no-result "pid not alive".
  it("reports completed for a complete 0-bar bundle, even with a dead pid", () => {
    const dir = path.join(root, "exp0bar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({ symbol: "NQ", barsEvaluated: 0, fiveMBarsLoaded: 0, perMode: [], runId: "r0" }),
    );
    const p = runner().probe(rec("exp0bar", 999999));
    expect(p.state).toBe("completed");
    expect(p.result?.barsEvaluated).toBe(0);
  });

  // #1 — disk-adopted bundles must carry the intended private SHA so the
  // provenance SHA-mismatch blocker can still fire (the probe path does this).
  it("scanCompleted stamps the intended private SHA (provenance not bypassed)", () => {
    const dir = path.join(root, "expSha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({ symbol: "NQ", barsEvaluated: 10, fiveMBarsLoaded: 10, perMode: [] }),
    );
    writeFileSync(
      path.join(dir, "run-meta.json"),
      JSON.stringify({ spec: { symbol: "NQ", startDay: "2026-04-01", endDay: "2026-05-01" } }),
    );
    const r = new NinjaTraderRunner({ repoRoot: root, resultsRoot: root, privateShaResolver: () => "STUBSHA" });
    const scan = r.scanCompleted().find((s) => s.id === "expSha");
    expect(scan?.result.provenance.privateShaIntended).toBe("STUBSHA");
  });
});
