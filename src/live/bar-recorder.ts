import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { BarCloseMessage } from "../bridge/protocol.js";
import { onMessage } from "../bridge/index.js";

export interface RecordedBar {
  receivedAtMs: number;
  symbol: string;
  timeframe: string;
  timestamp: number; // bar close, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  lagSeconds: number; // round(receivedAtMs / 1000 - timestamp)
}

export interface SubscriptionStatus {
  symbol: string;
  timeframe: string;
  count: number;
  lastReceivedTs: number | null;
  lastLagSeconds: number | null;
  dupCount: number;
}

export interface LiveBarRecorderOptions {
  dir?: string;
  ringCapacity?: number;
  now?: () => number; // ms
}

export class LiveBarRecorder {
  private readonly dir: string;
  private readonly cap: number;
  private readonly now: () => number;
  private ring: RecordedBar[] = [];
  private readonly status = new Map<string, SubscriptionStatus>();
  private readonly seen = new Map<string, Set<number>>();

  constructor(opts: LiveBarRecorderOptions = {}) {
    this.dir = opts.dir ?? join(process.cwd(), "data", "diagnostics");
    this.cap = opts.ringCapacity ?? 500;
    this.now = opts.now ?? ((): number => Date.now());
  }

  record(msg: BarCloseMessage): void {
    try {
      const c = msg.candle;
      const receivedAtMs = this.now();
      const lagSeconds = Math.round(receivedAtMs / 1000 - c.timestamp);
      const bar: RecordedBar = {
        receivedAtMs,
        symbol: msg.symbol,
        timeframe: msg.timeframe,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        lagSeconds,
      };

      const key = `${msg.symbol}:${msg.timeframe}`;
      const seenSet = this.seen.get(key) ?? new Set<number>();
      const isDup = seenSet.has(c.timestamp);
      seenSet.add(c.timestamp);
      this.seen.set(key, seenSet);

      this.ring.push(bar);
      if (this.ring.length > this.cap) this.ring.shift();

      const s: SubscriptionStatus =
        this.status.get(key) ?? {
          symbol: msg.symbol,
          timeframe: msg.timeframe,
          count: 0,
          lastReceivedTs: null,
          lastLagSeconds: null,
          dupCount: 0,
        };
      s.count += 1;
      s.lastReceivedTs = c.timestamp;
      s.lastLagSeconds = lagSeconds;
      if (isDup) s.dupCount += 1;
      this.status.set(key, s);

      this.appendJsonl(bar);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[live-recorder] record failed: ${m}`);
    }
  }

  recent(filter: { symbol?: string; limit?: number } = {}): RecordedBar[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 20, this.cap));
    const bars = filter.symbol ? this.ring.filter((b) => b.symbol === filter.symbol) : this.ring;
    return bars.slice(-limit).reverse(); // newest first
  }

  subscriptions(): SubscriptionStatus[] {
    return [...this.status.values()];
  }

  private appendJsonl(bar: RecordedBar): void {
    const day = isoDayUtc(bar.timestamp);
    const file = join(this.dir, `live-bars-${bar.symbol}-${bar.timeframe}-${day}.jsonl`);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(bar)}\n`);
  }
}

function isoDayUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// App-wide singleton, shared with the diagnostic MCP tools.
export const liveBarRecorder = new LiveBarRecorder();

// Hook every received bar_close into the recorder. Independent of the ingest
// handler (onMessage stores a Set of handlers per type), so both run.
export function registerLiveBarRecorder(): void {
  onMessage("bar_close", (msg) => liveBarRecorder.record(msg));
}
