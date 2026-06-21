// ─────────────────────────────────────────────────────────────────────────────
// Observability core — the extractable, zero-dependency heart of the lab.
//
// Shape is deliberately OpenTelemetry-ish (traces → spans → events/metrics) but
// with NO otel dependency, so it drops into any codebase. Everything a producer
// emits is normalized into a single ObservabilityRecord union and fanned out to
// pluggable Sinks. Write a Datadog/OTel/Grafana sink by implementing one method.
// ─────────────────────────────────────────────────────────────────────────────

export type AttrValue = string | number | boolean | null | undefined;
export type Attributes = Record<string, AttrValue>;

export type ObservabilityRecord =
  | {
      kind: "span_start";
      ts: number;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      name: string;
      attrs: Attributes;
    }
  | {
      kind: "span_end";
      ts: number;
      traceId: string;
      spanId: string;
      name: string;
      durationMs: number;
      status: "ok" | "error";
      attrs: Attributes;
    }
  | {
      kind: "event";
      ts: number;
      traceId: string;
      spanId?: string;
      name: string;
      attrs: Attributes;
    }
  | {
      kind: "metric";
      ts: number;
      traceId: string;
      spanId?: string;
      name: string;
      value: number;
      unit?: string;
      attrs: Attributes;
    };

/**
 * A destination for observability records. The ONLY thing you implement to
 * teach the lab a new backend (Datadog, OTLP, a websocket, a file, …).
 * Sinks MUST NOT throw — the tracer guards calls, but be defensive.
 */
export interface Sink {
  readonly name: string;
  handle(record: ObservabilityRecord): void;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  /** Emit a point-in-time event scoped to this span. */
  event(name: string, attrs?: Attributes): void;
  /** Emit a numeric measurement scoped to this span. */
  metric(name: string, value: number, opts?: { unit?: string; attrs?: Attributes }): void;
  /** Open a child span. */
  startSpan(name: string, attrs?: Attributes): Span;
  /** Close the span (idempotent); records duration. */
  end(opts?: { status?: "ok" | "error"; attrs?: Attributes }): void;
}

export interface Tracer {
  readonly traceId: string;
  startSpan(name: string, attrs?: Attributes): Span;
  event(name: string, attrs?: Attributes): void;
  metric(name: string, value: number, opts?: { unit?: string; attrs?: Attributes }): void;
}
