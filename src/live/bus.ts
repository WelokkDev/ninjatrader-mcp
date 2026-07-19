import type { CandlePayload } from "../bridge/protocol.js";

export interface LiveBarEvent {
  symbol: string;
  timeframe: string;
  candle: CandlePayload;
  seq?: number;
  backfill?: boolean;
  contract?: string;
  receivedAtMs: number;
}

export type LiveBarListener = (e: LiveBarEvent) => void;

/**
 * In-process fan-out. Listeners are isolated — one throwing consumer never
 * affects the others or the feed.
 */
export class Bus<T> {
  private readonly listeners = new Set<(e: T) => void>();

  subscribe(listener: (e: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: T): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[live-bus] listener error:", err);
      }
    }
  }
}

/** Post-ingest live bars (kept as a named class for existing call sites). */
export class LiveFeedBus extends Bus<LiveBarEvent> {}
