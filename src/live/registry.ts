import type { Database } from "better-sqlite3";
import { LIVE_TIMEFRAMES } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import type {
  BarCloseMessage,
  SubscribeAckMessage,
} from "../bridge/protocol.js";

export type LiveTimeframe = "15s" | "5m" | "15m";

/** Persisted operator source; "consumer:<n>" sources die with their socket. */
export const MCP_SOURCE = "mcp";

const SUBSCRIBE_TIMEOUT_MS = 15_000;
const UNSUBSCRIBE_TIMEOUT_MS = 10_000;

const RECOMPILE_HINT =
  "— the NT8 AddOn may predate subscribe_bars; recompile ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor (F5)";

export interface LiveSubState {
  symbol: string;
  timeframe: LiveTimeframe;
  sources: string[];
  acked: boolean;
  contract: string | null;
  lastSeq: number | null;
  lastTs: number | null;
  lastError: string | null;
  subscribedAt: number;
  ackedAt: number | null;
}

export interface EnsureResult {
  ok: boolean;
  state: LiveSubState;
  error?: string;
}

export interface RegistryDeps {
  db: Database;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  isConnected: () => boolean;
  nowUnix?: () => number;
}

interface SubEntry {
  symbol: string;
  timeframe: LiveTimeframe;
  tradingHoursTemplate: string;
  sources: Set<string>;
  acked: boolean;
  contract: string | null;
  lastSeq: number | null;
  lastTs: number | null;
  lastError: string | null;
  subscribedAt: number;
  ackedAt: number | null;
}

function key(symbol: string, timeframe: string): string {
  return `${symbol}:${timeframe}`;
}

/**
 * Authoritative desired-state of live subscriptions. The AddOn side is
 * disposable (NT restarts, feed reconnects); replaying this set on every
 * hello keeps the feed alive without operator action.
 */
export class LiveSubscriptionRegistry {
  private readonly subs = new Map<string, SubEntry>();
  // Failed/unsent upstream releases; flushed on the next hello.
  private readonly pendingUnsubs = new Map<string, { symbol: string; timeframe: LiveTimeframe }>();
  private readonly deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.nowUnix ? this.deps.nowUnix() : Math.floor(Date.now() / 1000);
  }

  /** Restore operator-desired subs recorded by a previous server process. */
  loadPersisted(): void {
    const rows = this.deps.db
      .prepare("SELECT symbol, timeframe, created_at FROM live_subscriptions")
      .all() as Array<{ symbol: string; timeframe: string; created_at: number }>;
    for (const row of rows) {
      if (this.subs.has(key(row.symbol, row.timeframe))) continue;
      let template: string;
      try {
        template = getInstrumentConfig(row.symbol).session.name;
      } catch {
        console.error(
          `[live-registry] dropping persisted sub for unknown symbol ${row.symbol}`,
        );
        continue;
      }
      this.subs.set(key(row.symbol, row.timeframe), {
        symbol: row.symbol,
        timeframe: row.timeframe as LiveTimeframe,
        tradingHoursTemplate: template,
        sources: new Set([MCP_SOURCE]),
        acked: false,
        contract: null,
        lastSeq: null,
        lastTs: null,
        lastError: null,
        subscribedAt: row.created_at,
        ackedAt: null,
      });
    }
  }

  async ensure(
    symbol: string,
    timeframe: LiveTimeframe,
    source: string,
  ): Promise<EnsureResult> {
    let template: string;
    try {
      template = getInstrumentConfig(symbol).session.name;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false, state: this.deadState(symbol, timeframe), error: m };
    }
    if (!LIVE_TIMEFRAMES.includes(timeframe)) {
      return {
        ok: false,
        state: this.deadState(symbol, timeframe),
        error: `'${timeframe}' is not a streamable raw timeframe (${LIVE_TIMEFRAMES.join(", ")})`,
      };
    }

    const k = key(symbol, timeframe);
    // Re-subscribing wins over any not-yet-flushed upstream release.
    this.pendingUnsubs.delete(k);
    let entry = this.subs.get(k);
    const isNew = !entry;
    if (!entry) {
      entry = {
        symbol,
        timeframe,
        tradingHoursTemplate: template,
        sources: new Set(),
        acked: false,
        contract: null,
        lastSeq: null,
        lastTs: null,
        lastError: null,
        subscribedAt: this.now(),
        ackedAt: null,
      };
      this.subs.set(k, entry);
    }
    entry.sources.add(source);
    if (source === MCP_SOURCE) this.persist(entry);

    // Already live upstream and nothing to (re)negotiate — done.
    if (entry.acked && !isNew) {
      return { ok: true, state: this.toState(entry) };
    }

    if (!this.deps.isConnected()) {
      entry.lastError =
        "NinjaTrader bridge not connected — subscription recorded and will activate on next hello.";
      return { ok: false, state: this.toState(entry), error: entry.lastError };
    }

    return this.subscribeUpstream(entry);
  }

  private async subscribeUpstream(entry: SubEntry): Promise<EnsureResult> {
    try {
      // request may throw synchronously (disconnected) — catch covers both shapes.
      const res = (await this.deps.request(
        "subscribe_bars",
        {
          symbol: entry.symbol,
          timeframe: entry.timeframe,
          tradingHoursTemplate: entry.tradingHoursTemplate,
        },
        SUBSCRIBE_TIMEOUT_MS,
      )) as SubscribeAckMessage;
      entry.acked = true;
      entry.contract = res.contract ?? null;
      entry.ackedAt = this.now();
      entry.lastError = null;
      return { ok: true, state: this.toState(entry) };
    } catch (err) {
      let m = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(m)) m = `${m} ${RECOMPILE_HINT}`;
      entry.acked = false;
      entry.lastError = m;
      return { ok: false, state: this.toState(entry), error: m };
    }
  }

  async release(
    symbol: string,
    timeframe: LiveTimeframe,
    source: string,
  ): Promise<{ removedUpstream: boolean; pendingUpstreamRelease?: boolean }> {
    const k = key(symbol, timeframe);
    const entry = this.subs.get(k);
    if (!entry) return { removedUpstream: false };
    entry.sources.delete(source);
    if (source === MCP_SOURCE) this.unpersist(entry);
    if (entry.sources.size > 0) return { removedUpstream: false };

    this.subs.delete(k);
    if (this.deps.isConnected()) {
      try {
        await this.deps.request(
          "unsubscribe_bars",
          { symbol, timeframe },
          UNSUBSCRIBE_TIMEOUT_MS,
        );
        return { removedUpstream: true };
      } catch (err) {
        // Contain it (ws close handlers call this); track for retry on next hello.
        const m = err instanceof Error ? err.message : String(err);
        console.error(
          `[live-registry] unsubscribe_bars ${k} failed (will retry on next hello): ${m}`,
        );
      }
    }
    this.pendingUnsubs.set(k, { symbol, timeframe });
    return { removedUpstream: false, pendingUpstreamRelease: true };
  }

  /** Keys released locally whose upstream unsubscribe hasn't succeeded yet. */
  pendingUnsubscribeKeys(): string[] {
    return [...this.pendingUnsubs.keys()];
  }

  async releaseAllForSource(source: string): Promise<void> {
    const held = [...this.subs.values()].filter((e) => e.sources.has(source));
    for (const e of held) {
      await this.release(e.symbol, e.timeframe, source);
    }
  }

  /** Update per-stream cursors from an incoming bar_close. Unknown key = no-op. */
  noteBar(msg: BarCloseMessage): void {
    const entry = this.subs.get(key(msg.symbol, msg.timeframe));
    if (!entry) return;
    if (typeof msg.seq === "number") entry.lastSeq = msg.seq;
    entry.lastTs = msg.candle.timestamp;
    if (msg.contract) entry.contract = msg.contract;
  }

  /** Reconcile an ack that arrived after its request timed out (slow seed). */
  noteAck(msg: SubscribeAckMessage): void {
    const entry = this.subs.get(key(msg.symbol, msg.timeframe));
    if (!entry) return;
    entry.acked = true;
    entry.contract = msg.contract ?? entry.contract;
    entry.ackedAt = this.now();
    entry.lastError = null;
  }

  list(): LiveSubState[] {
    return [...this.subs.values()].map((e) => this.toState(e));
  }

  /** Re-send subscribe_bars for every desired sub (idempotent AddOn-side). */
  async replayAll(): Promise<{ replayed: number; failed: number }> {
    // Flush upstream releases that failed earlier.
    for (const [k, pending] of [...this.pendingUnsubs]) {
      if (this.subs.has(k)) {
        this.pendingUnsubs.delete(k); // re-subscribed since; nothing to release
        continue;
      }
      try {
        await this.deps.request(
          "unsubscribe_bars",
          { symbol: pending.symbol, timeframe: pending.timeframe },
          UNSUBSCRIBE_TIMEOUT_MS,
        );
        this.pendingUnsubs.delete(k);
        console.error(`[live-registry] flushed pending unsubscribe for ${k}`);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[live-registry] pending unsubscribe ${k} still failing: ${m}`);
      }
    }

    let replayed = 0;
    let failed = 0;
    for (const entry of this.subs.values()) {
      entry.acked = false; // the AddOn may have restarted; re-prove liveness
      const res = await this.subscribeUpstream(entry);
      if (res.ok) replayed++;
      else failed++;
    }
    return { replayed, failed };
  }

  private persist(entry: SubEntry): void {
    this.deps.db
      .prepare(
        `INSERT OR IGNORE INTO live_subscriptions (symbol, timeframe, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(entry.symbol, entry.timeframe, entry.subscribedAt);
  }

  private unpersist(entry: SubEntry): void {
    this.deps.db
      .prepare("DELETE FROM live_subscriptions WHERE symbol = ? AND timeframe = ?")
      .run(entry.symbol, entry.timeframe);
  }

  private toState(e: SubEntry): LiveSubState {
    return {
      symbol: e.symbol,
      timeframe: e.timeframe,
      sources: [...e.sources],
      acked: e.acked,
      contract: e.contract,
      lastSeq: e.lastSeq,
      lastTs: e.lastTs,
      lastError: e.lastError,
      subscribedAt: e.subscribedAt,
      ackedAt: e.ackedAt,
    };
  }

  private deadState(symbol: string, timeframe: LiveTimeframe): LiveSubState {
    return {
      symbol,
      timeframe,
      sources: [],
      acked: false,
      contract: null,
      lastSeq: null,
      lastTs: null,
      lastError: null,
      subscribedAt: this.now(),
      ackedAt: null,
    };
  }
}
