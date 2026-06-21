import type { Attributes, ObservabilityRecord, Sink, Span, Tracer } from "./types.js";
import { systemClock, type Clock } from "../clock.js";
import { newSpanId, newTraceId } from "../ids.js";

export interface TracerOptions {
  traceId?: string;
  sinks?: Sink[];
  clock?: Clock;
  /** Attributes stamped onto every record from this tracer (e.g. experimentId). */
  baseAttrs?: Attributes;
}

interface TracerCtx {
  traceId: string;
  sinks: Sink[];
  clock: Clock;
  baseAttrs: Attributes;
}

function merge(base: Attributes, extra?: Attributes): Attributes {
  return extra ? { ...base, ...extra } : { ...base };
}

function emit(ctx: TracerCtx, rec: ObservabilityRecord): void {
  for (const sink of ctx.sinks) {
    try {
      sink.handle(rec);
    } catch {
      // A misbehaving sink must never break the run it is observing.
    }
  }
}

class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  private ended = false;
  private readonly startTs: number;

  constructor(
    private readonly ctx: TracerCtx,
    readonly name: string,
    parentSpanId: string | undefined,
    attrs?: Attributes,
  ) {
    this.traceId = ctx.traceId;
    this.spanId = newSpanId();
    this.startTs = ctx.clock.now();
    emit(ctx, {
      kind: "span_start",
      ts: this.startTs,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId,
      name,
      attrs: merge(ctx.baseAttrs, attrs),
    });
  }

  event(name: string, attrs?: Attributes): void {
    emit(this.ctx, {
      kind: "event",
      ts: this.ctx.clock.now(),
      traceId: this.traceId,
      spanId: this.spanId,
      name,
      attrs: merge(this.ctx.baseAttrs, attrs),
    });
  }

  metric(name: string, value: number, opts?: { unit?: string; attrs?: Attributes }): void {
    emit(this.ctx, {
      kind: "metric",
      ts: this.ctx.clock.now(),
      traceId: this.traceId,
      spanId: this.spanId,
      name,
      value,
      unit: opts?.unit,
      attrs: merge(this.ctx.baseAttrs, opts?.attrs),
    });
  }

  startSpan(name: string, attrs?: Attributes): Span {
    return new SpanImpl(this.ctx, name, this.spanId, attrs);
  }

  end(opts?: { status?: "ok" | "error"; attrs?: Attributes }): void {
    if (this.ended) return;
    this.ended = true;
    const ts = this.ctx.clock.now();
    emit(this.ctx, {
      kind: "span_end",
      ts,
      traceId: this.traceId,
      spanId: this.spanId,
      name: this.name,
      durationMs: ts - this.startTs,
      status: opts?.status ?? "ok",
      attrs: merge(this.ctx.baseAttrs, opts?.attrs),
    });
  }
}

class TracerImpl implements Tracer {
  constructor(private readonly ctx: TracerCtx) {}

  get traceId(): string {
    return this.ctx.traceId;
  }

  startSpan(name: string, attrs?: Attributes): Span {
    return new SpanImpl(this.ctx, name, undefined, attrs);
  }

  event(name: string, attrs?: Attributes): void {
    emit(this.ctx, {
      kind: "event",
      ts: this.ctx.clock.now(),
      traceId: this.ctx.traceId,
      name,
      attrs: merge(this.ctx.baseAttrs, attrs),
    });
  }

  metric(name: string, value: number, opts?: { unit?: string; attrs?: Attributes }): void {
    emit(this.ctx, {
      kind: "metric",
      ts: this.ctx.clock.now(),
      traceId: this.ctx.traceId,
      name,
      value,
      unit: opts?.unit,
      attrs: merge(this.ctx.baseAttrs, opts?.attrs),
    });
  }
}

export function createTracer(opts: TracerOptions = {}): Tracer {
  return new TracerImpl({
    traceId: opts.traceId ?? newTraceId(),
    sinks: opts.sinks ?? [],
    clock: opts.clock ?? systemClock,
    baseAttrs: opts.baseAttrs ?? {},
  });
}
