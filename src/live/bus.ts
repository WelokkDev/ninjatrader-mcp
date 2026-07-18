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
 * In-process fan-out for post-ingest live bars. Listeners are isolated —
 * one throwing consumer never affects the others or the feed.
 */
export class LiveFeedBus {
  private readonly listeners = new Set<LiveBarListener>();

  subscribe(listener: LiveBarListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: LiveBarEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[live-bus] listener error:", err);
      }
    }
  }
}
