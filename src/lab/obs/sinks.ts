import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { ObservabilityRecord, Sink } from "./types.js";

// ── Memory sink ──────────────────────────────────────────────────────────────
// A bounded ring buffer you can query — powers live status polling without any
// external system. `last` finds the most recent record matching a predicate
// (e.g. the latest "bar.progress" event) in O(n) over a small buffer.

export interface MemorySink extends Sink {
  records(): ObservabilityRecord[];
  last(predicate?: (r: ObservabilityRecord) => boolean): ObservabilityRecord | undefined;
  clear(): void;
}

export function memorySink(opts: { capacity?: number; name?: string } = {}): MemorySink {
  const capacity = opts.capacity ?? 1000;
  const buf: ObservabilityRecord[] = [];
  return {
    name: opts.name ?? "memory",
    handle(record) {
      buf.push(record);
      if (buf.length > capacity) buf.shift();
    },
    records() {
      return buf.slice();
    },
    last(predicate) {
      for (let i = buf.length - 1; i >= 0; i--) {
        const r = buf[i]!;
        if (!predicate || predicate(r)) return r;
      }
      return undefined;
    },
    clear() {
      buf.length = 0;
    },
  };
}

// ── JSONL sink ───────────────────────────────────────────────────────────────
// One record per line, append-only. The on-disk trace of a run; tail it, grep
// it, or replay it. Uses a buffered append stream.

export function jsonlSink(filePath: string, opts: { name?: string } = {}): Sink {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let stream: WriteStream | null = createWriteStream(filePath, { flags: "a" });
  return {
    name: opts.name ?? "jsonl",
    handle(record) {
      stream?.write(JSON.stringify(record) + "\n");
    },
    close() {
      return new Promise<void>((resolve) => {
        if (!stream) return resolve();
        stream.end(() => resolve());
        stream = null;
      });
    },
  };
}

// ── Console sink ─────────────────────────────────────────────────────────────
// Human-readable lines to a stream (stderr by default — stdout stays clean for
// structured protocols like MCP/stdio).

export function consoleSink(opts: { stream?: NodeJS.WritableStream; name?: string } = {}): Sink {
  const stream = opts.stream ?? process.stderr;
  const fmtAttrs = (a: Record<string, unknown>): string => {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    return keys.length ? " " + keys.map((k) => `${k}=${a[k]}`).join(" ") : "";
  };
  return {
    name: opts.name ?? "console",
    handle(record) {
      switch (record.kind) {
        case "span_start":
          stream.write(`▶ ${record.name}${fmtAttrs(record.attrs)}\n`);
          break;
        case "span_end":
          stream.write(`◀ ${record.name} (${record.durationMs}ms ${record.status})\n`);
          break;
        case "event":
          stream.write(`• ${record.name}${fmtAttrs(record.attrs)}\n`);
          break;
        case "metric":
          stream.write(`◇ ${record.name}=${record.value}${record.unit ?? ""}\n`);
          break;
      }
    },
  };
}

// ── Combinators ──────────────────────────────────────────────────────────────

/** Fan one record out to many sinks. */
export function multiSink(...sinks: Sink[]): Sink {
  return {
    name: "multi",
    handle(record) {
      for (const s of sinks) {
        try {
          s.handle(record);
        } catch {
          /* isolate sink failures */
        }
      }
    },
    async flush() {
      await Promise.all(sinks.map((s) => s.flush?.()));
    },
    async close() {
      await Promise.all(sinks.map((s) => s.close?.()));
    },
  };
}

/** Only forward records matching the predicate. */
export function filterSink(sink: Sink, predicate: (r: ObservabilityRecord) => boolean): Sink {
  return {
    name: `filter(${sink.name})`,
    handle(record) {
      if (predicate(record)) sink.handle(record);
    },
    flush: sink.flush?.bind(sink),
    close: sink.close?.bind(sink),
  };
}
