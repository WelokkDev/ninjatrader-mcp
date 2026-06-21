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
