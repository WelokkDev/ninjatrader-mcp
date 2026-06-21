import { describe, it, expect } from "vitest";
import { createTracer } from "../obs/tracer.js";
import { memorySink, multiSink, filterSink } from "../obs/sinks.js";
import type { Sink } from "../obs/types.js";
import { manualClock } from "../clock.js";

describe("observability core", () => {
  it("emits span_start/end with duration + base attrs, plus events and metrics", () => {
    const mem = memorySink();
    const clock = manualClock(1000);
    const tracer = createTracer({
      traceId: "t1",
      sinks: [mem],
      clock,
      baseAttrs: { experimentId: "e1" },
    });

    const span = tracer.startSpan("walk", { engine: "observe" });
    clock.advance(50);
    span.event("bar.progress", { unitsDone: 5 });
    span.metric("ms_per_unit", 12, { unit: "ms" });
    clock.advance(10);
    span.end();

    const recs = mem.records();
    expect(recs[0]!.kind).toBe("span_start");
    expect(recs[0]!.attrs.experimentId).toBe("e1");
    expect(recs[0]!.attrs.engine).toBe("observe");

    const end = recs.find((r) => r.kind === "span_end");
    expect(end?.kind === "span_end" && end.durationMs).toBe(60);

    expect(recs.some((r) => r.kind === "event" && r.name === "bar.progress")).toBe(true);
    expect(recs.some((r) => r.kind === "metric" && r.value === 12)).toBe(true);
  });

  it("memorySink.last finds the most recent matching record", () => {
    const mem = memorySink();
    const tracer = createTracer({ sinks: [mem] });
    tracer.event("a");
    tracer.event("bar.progress", { unitsDone: 1 });
    tracer.event("bar.progress", { unitsDone: 9 });
    const last = mem.last((r) => r.name === "bar.progress");
    expect(last?.attrs.unitsDone).toBe(9);
  });

  it("filterSink forwards only matches; multiSink fans out", () => {
    const a = memorySink();
    const b = memorySink();
    const onlyMetrics = filterSink(b, (r) => r.kind === "metric");
    const tracer = createTracer({ sinks: [multiSink(a, onlyMetrics)] });
    tracer.event("e1");
    tracer.metric("m1", 3);
    expect(a.records()).toHaveLength(2);
    expect(b.records()).toHaveLength(1);
    expect(b.records()[0]!.kind).toBe("metric");
  });

  it("a throwing sink never breaks emission to other sinks", () => {
    const good = memorySink();
    const bad: Sink = {
      name: "bad",
      handle() {
        throw new Error("boom");
      },
    };
    const tracer = createTracer({ sinks: [bad, good] });
    expect(() => tracer.event("x")).not.toThrow();
    expect(good.records()).toHaveLength(1);
  });
});
