# Strategy Lab

A small, **framework-agnostic** backtest research lab: launch experiments asynchronously, watch them with deep observability, get honest ETAs, and gate results with integrity checks — then read a token-tiny verdict instead of a 300 MB trace file.

Nothing in `src/lab` knows about NinjaTrader, SQLite-vs-anything, or MCP. Engines plug in behind one interface (`BacktestRunner`); observability streams to any backend behind one interface (`Sink`); storage is behind one interface (`ExperimentStore`). **To drop this into another backtesting platform, you implement one runner and (optionally) one sink.**

```
src/lab/
  obs/         observability core — Tracer/Span → ObservabilityRecord → Sink   (ZERO deps)
  store/       ExperimentStore: memory + sqlite
  runner/      BacktestRunner seam + a deterministic FakeRunner
  eta/         rolling-median ETA calibrator (honest p50 + band)
  integrity/   pluggable trust gates (causal / cache / provenance)
  lab.ts       the orchestrator (lifecycle, concurrency, queueing)
  diff.ts      result A/B comparison
adapters/ninjatrader/   THE only engine-specific code (spawns a backtest script)
src/tools/*experiment*   one MCP frontend over the Lab
```

## Quick start (zero deps, in-memory)

```ts
import { Lab, MemoryExperimentStore, FakeRunner, consoleSink } from "./lab/index.js";

const lab = new Lab({
  store: new MemoryExperimentStore(),
  runner: new FakeRunner({ unitsTotal: 1000, funnel: { yes: 3 } }),
  sinks: [consoleSink()],
});

const { experimentId, etaText } = await lab.start({
  symbol: "NQ", startDay: "2026-04-01", endDay: "2026-05-01", engine: "observe",
});
console.log("launched", experimentId, "eta", etaText);

await lab.waitFor(experimentId);
console.log(lab.result(experimentId));   // token-tiny normalized verdict + integrity report
```

## Plug in YOUR engine (the friend's drop-in)

Implement `BacktestRunner`. Report progress + a terminal result via the `RunContext` you're handed — that's the whole contract. Run in-process, in a child process, or on a remote box; the lab doesn't care.

```ts
import type { BacktestRunner, RunContext, RunHandle } from "./lab/index.js";

class MyEngineRunner implements BacktestRunner {
  readonly name = "my-engine";

  estimateUnits(spec) { return countBars(spec); }      // optional, for a launch-time ETA

  start(ctx: RunContext): RunHandle {
    runMyBacktest(ctx.spec, {
      onBar: (done, total) => ctx.progress({ unitsDone: done, unitsTotal: total }),
      onDone: (out) => ctx.complete({
        experimentId: ctx.experimentId,
        runner: this.name,
        symbol: ctx.spec.symbol,
        barsEvaluated: out.bars,
        funnel: { yes: out.setups, byReason: out.rejections },
        perMode: out.perMode,                            // [{mode,nTrades,wins,losses,winRate,sumR,avgR}]
        provenance: { configHash: out.hash, engine: ctx.spec.engine },
        signals: { barsLoaded: out.bars, causality: { entriesChecked: out.entries, violations: 0 } },
        timing: { wallClockMs: out.ms },
      }),
      onError: (e) => ctx.fail(String(e)),
    });
    return { experimentId: ctx.experimentId };
  }
}

const lab = new Lab({ store: new MemoryExperimentStore(), runner: new MyEngineRunner() });
```

You immediately get: async lifecycle, concurrency cap + queueing, live status, ETA calibration, integrity gating, diff, and (if you wire the MCP tools) a remote API — for free.

## Stream observability anywhere (the Datadog/OTel seam)

A `Sink` is one method. Ship records to a file, a websocket, Datadog, OTLP, whatever:

```ts
import type { Sink } from "./lab/index.js";

const datadogSink: Sink = {
  name: "datadog",
  handle(record) {
    // record is a typed union: span_start | span_end | event | metric
    if (record.kind === "metric") sendToDatadog(record.name, record.value, record.attrs);
  },
};

const lab = new Lab({ store, runner, sinks: [datadogSink, jsonlSink("events.jsonl")] });
```

Built-in sinks: `memorySink` (queryable ring buffer — powers live status), `jsonlSink` (append-only file), `consoleSink` (stderr), `multiSink`, `filterSink`.

## Durable storage

```ts
import { SqliteExperimentStore, openLabDatabase } from "./lab/index.js";
const store = new SqliteExperimentStore(openLabDatabase("data/lab.db"));  // own table + WAL + busy_timeout
const lab = new Lab({ store, runner });
lab.reconcile();   // on startup: orphan crashed runs, resume the queue
```

## Integrity gates (the trust layer)

After every run the lab applies `IntegrityCheck`s and stamps the verdict onto the result. A **blocker** failure flips the experiment to `failed` so it's excluded from any ranking. Defaults:

- **causal** — runner must report 0 look-ahead violations (BLOCKER).
- **cache** — 0 bars loaded ⇒ the false-0 trap (BLOCKER).
- **provenance** — intended ≠ observed engine SHA (BLOCKER); dirty tree (WARN).

Add your own: `new Lab({ ..., integrityChecks: [...defaultChecks, myCheck] })`.

## ETA

Per-run cost is wildly unstable (measured ~120× swings from machine load), so the calibrator keeps a rolling sample per `runner:mode`, reports the **median**, and exposes a **p50…p90 band**. `etaText` says e.g. `~35m` or `~35m (cold estimate — could be very off)` when there's no data yet.

---

## What's generic vs NinjaTrader-specific

- **Generic (`src/lab`)**: everything above. No engine, broker, or product names.
- **Specific (`src/adapters/ninjatrader`)**: spawns `run-backtest-observable` as a detached child and maps its bundle to the generic `ExperimentResult`. It imports **nothing** from the private engine — it launches a path string.

### Note on live NinjaTrader progress
The NT adapter reports `queued → running → done/failed` today and reads a `progress.json` from the bundle dir **if the runner writes one**. To light up fine-grained live bar progress for the real engine, the runner needs a small edit (thread an `onProgress(barsDone,barsTotal)` callback that writes `progress.json`). The lab is already wired to consume it; no lab changes needed.
