import { describe, it, expect } from "vitest";
import { Lab } from "../lab.js";
import { MemoryExperimentStore } from "../store/memory-store.js";
import { FakeRunner } from "../runner/fake-runner.js";
import { memorySink } from "../obs/sinks.js";
import type { BacktestRunner, RunContext, RunHandle } from "../runner/types.js";
import type { ExperimentResult, ExperimentSpec } from "../types.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
const spec = (over: Partial<ExperimentSpec> = {}): ExperimentSpec => ({
  symbol: "NQ",
  startDay: "2026-04-01",
  endDay: "2026-05-01",
  engine: "observe",
  ...over,
});

describe("Lab end-to-end (FakeRunner)", () => {
  it("runs an experiment to a clean, integrity-passing 'done'", async () => {
    const sink = memorySink();
    const lab = new Lab({
      store: new MemoryExperimentStore(),
      runner: new FakeRunner({ unitsTotal: 50, progressTicks: 3, funnel: { yes: 2 } }),
      sinks: [sink],
    });
    const { experimentId, etaSecs } = await lab.start(spec({ label: "baseline" }));
    expect(etaSecs).not.toBeNull();

    const rec = await lab.waitFor(experimentId);
    expect(rec.status).toBe("done");

    const res = lab.result(experimentId)!;
    expect(res.funnel.yes).toBe(2);
    expect(res.integrity?.ok).toBe(true);

    const st = lab.status(experimentId)!;
    expect(st.pct).toBe(100);

    // The whole lifecycle was observed.
    const names = sink.records().map((r) => r.name);
    expect(names).toContain("experiment.started");
    expect(names).toContain("experiment.completed");
    expect(sink.records().some((r) => r.kind === "metric")).toBe(true);
  });

  it("EXCLUDES a look-ahead variant: integrity blocker → status 'failed'", async () => {
    const lab = new Lab({
      store: new MemoryExperimentStore(),
      runner: new FakeRunner({
        unitsTotal: 20,
        funnel: { yes: 5 },
        signals: { barsLoaded: 20, causality: { entriesChecked: 5, violations: 3 } },
      }),
    });
    const { experimentId } = await lab.start(spec());
    const rec = await lab.waitFor(experimentId);
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/causal/i);
    expect(lab.result(experimentId)?.integrity?.ok).toBe(false);
  });

  it("records a failed run when the runner fails", async () => {
    const lab = new Lab({
      store: new MemoryExperimentStore(),
      runner: new FakeRunner({ fail: "boom" }),
    });
    const { experimentId } = await lab.start(spec());
    const rec = await lab.waitFor(experimentId);
    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("boom");
  });

  it("enforces the concurrency cap and drains the queue", async () => {
    // A runner we complete by hand, so we can observe queueing deterministically.
    const ctxById = new Map<string, RunContext>();
    const runner: BacktestRunner = {
      name: "control",
      estimateUnits: () => 100,
      start(ctx): RunHandle {
        ctxById.set(ctx.experimentId, ctx);
        return { experimentId: ctx.experimentId };
      },
    };
    const result = (ctx: RunContext): ExperimentResult => ({
      experimentId: ctx.experimentId,
      runner: "control",
      symbol: ctx.spec.symbol,
      barsEvaluated: 100,
      funnel: { yes: 0, byReason: {} },
      perMode: [],
      provenance: { engine: "observe", privateShaIntended: "x", privateShaObserved: "x" },
      signals: { barsLoaded: 100, causality: { entriesChecked: 0, violations: 0 } },
      timing: { wallClockMs: 1000, msPerUnit: 10 },
    });

    const lab = new Lab({ store: new MemoryExperimentStore(), runner, maxConcurrent: 2 });
    const a = await lab.start(spec());
    const b = await lab.start(spec());
    const c = await lab.start(spec());
    await flush();

    expect(lab.list({ status: "running" }).length).toBe(2);
    expect(lab.list({ status: "queued" }).length).toBe(1);
    expect(c.queued).toBe(true);

    // Finish one running → the queued one launches.
    ctxById.get(a.experimentId)!.complete(result(ctxById.get(a.experimentId)!));
    await flush();
    expect(lab.list({ status: "running" }).length).toBe(2);
    expect(lab.list({ status: "queued" }).length).toBe(0);
  });

  it("diffs two results and flags config changes as a non-clean A/B", async () => {
    const store = new MemoryExperimentStore();
    const labA = new Lab({ store, runner: new FakeRunner({ unitsTotal: 10, funnel: { yes: 1 } }) });
    const ra = await labA.start(spec({ label: "A" }));
    await labA.waitFor(ra.experimentId);

    const labB = new Lab({
      store,
      runner: new FakeRunner({
        unitsTotal: 10,
        funnel: { yes: 4 },
        provenance: { configHash: "different" },
      }),
    });
    const rb = await labB.start(spec({ label: "B" }));
    await labB.waitFor(rb.experimentId);

    const d = labB.diff(ra.experimentId, rb.experimentId);
    expect(d.funnelYes.delta).toBe(3);
    expect(d.configChanged).toBe(true);
    expect(d.caution).toBeTruthy();
  });
});

describe("Lab restart recovery (probe)", () => {
  const runningRec = (id: string, store: MemoryExperimentStore): void =>
    store.create({
      id,
      status: "running",
      runner: "fake",
      spec: spec(),
      createdAt: Date.now(),
      startedAt: Date.now(),
      pid: 4242,
      unitsTotal: 50,
    });

  const fakeResult = (id: string): ExperimentResult => ({
    experimentId: id,
    runner: "fake",
    symbol: "NQ",
    barsEvaluated: 50,
    funnel: { yes: 1, byReason: {} },
    perMode: [],
    provenance: { engine: "observe", privateShaIntended: "x", privateShaObserved: "x" },
    signals: { barsLoaded: 50, causality: { entriesChecked: 1, violations: 0 } },
    timing: { wallClockMs: 500, msPerUnit: 10 },
  });

  it("recovers a run that COMPLETED while the parent was gone", async () => {
    const store = new MemoryExperimentStore();
    runningRec("exp_a", store);
    const lab = new Lab({
      store,
      runner: new FakeRunner({ probeResult: { state: "completed", result: fakeResult("exp_a") } }),
    });
    await lab.reconcile();
    expect(store.get("exp_a")!.status).toBe("done");
    expect(lab.result("exp_a")?.integrity?.ok).toBe(true);
  });

  it("LEAVES a still-running run running (no false orphan)", async () => {
    const store = new MemoryExperimentStore();
    runningRec("exp_b", store);
    const lab = new Lab({ store, runner: new FakeRunner({ probeResult: { state: "running" } }) });
    await lab.reconcile();
    expect(store.get("exp_b")!.status).toBe("running");
  });

  it("fails a genuinely crashed run", async () => {
    const store = new MemoryExperimentStore();
    runningRec("exp_c", store);
    const lab = new Lab({
      store,
      runner: new FakeRunner({
        probeResult: { state: "failed", detail: "no bundle; pid 4242 not alive" },
      }),
    });
    await lab.reconcile();
    expect(store.get("exp_c")!.status).toBe("failed");
    expect(store.get("exp_c")!.error).toMatch(/no bundle/);
  });

  it("a periodic tick catches a completion the exit-callback missed", async () => {
    const store = new MemoryExperimentStore();
    let phase: { state: "running" | "completed" | "failed"; result?: ExperimentResult } = {
      state: "running",
    };
    const lab = new Lab({
      store,
      runner: new FakeRunner({ silent: true, probeResult: () => phase }),
    });
    const { experimentId } = await lab.start(spec());
    await flush();
    expect(store.get(experimentId)!.status).toBe("running");

    phase = { state: "completed", result: fakeResult(experimentId) };
    lab.startReconcileLoop(5);
    await new Promise((r) => setTimeout(r, 30));
    lab.stopReconcileLoop();
    expect(store.get(experimentId)!.status).toBe("done");
  });

  it("fails a run that has outlived maxRunningMs (hung or recycled pid)", async () => {
    const store = new MemoryExperimentStore();
    store.create({
      id: "old",
      status: "running",
      runner: "fake",
      spec: spec(),
      createdAt: 1,
      startedAt: 1,
      pid: 4242,
      unitsTotal: 50,
    });
    const lab = new Lab({
      store,
      maxRunningMs: 10,
      runner: new FakeRunner({ probeResult: { state: "running" } }),
    });
    await lab.reconcile();
    expect(store.get("old")!.status).toBe("failed");
    expect(store.get("old")!.error).toMatch(/max running age/);
  });

  it("leaves a young still-running run alone", async () => {
    const store = new MemoryExperimentStore();
    const now = Date.now();
    store.create({
      id: "young",
      status: "running",
      runner: "fake",
      spec: spec(),
      createdAt: now,
      startedAt: now,
      pid: 4242,
      unitsTotal: 50,
    });
    const lab = new Lab({
      store,
      maxRunningMs: 60_000,
      runner: new FakeRunner({ probeResult: { state: "running" } }),
    });
    await lab.reconcile();
    expect(store.get("young")!.status).toBe("running");
  });

  it("adopts a wrongly-orphaned failed row when a valid bundle is on disk", async () => {
    const store = new MemoryExperimentStore();
    store.create({
      id: "exp_o",
      status: "failed",
      error: "orphaned (lab restarted while running)",
      runner: "fake",
      spec: spec(),
      createdAt: 1,
      finishedAt: 2,
    });
    const lab = new Lab({
      store,
      runner: new FakeRunner({ scanResult: [{ id: "exp_o", result: fakeResult("exp_o"), spec: spec() }] }),
    });
    await lab.reconcile({ scanDisk: true });
    expect(store.get("exp_o")!.status).toBe("done");
  });

  it("does NOT resurrect an integrity-failed row from disk", async () => {
    const store = new MemoryExperimentStore();
    store.create({
      id: "exp_i",
      status: "failed",
      error: "integrity: 3 causal (look-ahead) violation(s)",
      runner: "fake",
      spec: spec(),
      createdAt: 1,
      finishedAt: 2,
    });
    const lab = new Lab({
      store,
      runner: new FakeRunner({ scanResult: [{ id: "exp_i", result: fakeResult("exp_i"), spec: spec() }] }),
    });
    await lab.reconcile({ scanDisk: true });
    expect(store.get("exp_i")!.status).toBe("failed");
  });

  it("creates and finalizes a row for a lab-launched bundle with no store row", async () => {
    const store = new MemoryExperimentStore();
    const lab = new Lab({
      store,
      runner: new FakeRunner({ scanResult: [{ id: "exp_new", result: fakeResult("exp_new"), spec: spec() }] }),
    });
    await lab.reconcile({ scanDisk: true });
    expect(store.get("exp_new")?.status).toBe("done");
  });

  it("ignores a foreign bundle that carries no run metadata (no spec)", async () => {
    const store = new MemoryExperimentStore();
    const lab = new Lab({
      store,
      runner: new FakeRunner({ scanResult: [{ id: "foreign", result: fakeResult("foreign") }] }),
    });
    await lab.reconcile({ scanDisk: true });
    expect(store.get("foreign")).toBeUndefined();
  });
});
