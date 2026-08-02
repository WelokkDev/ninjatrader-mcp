import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { Database } from "better-sqlite3";
import type {
  AccountSnapshotPayload,
  ExecutionPayload,
  PositionEventMessage,
  PositionsResponseMessage,
  PositionSyncMessage,
  PositionPayload,
  SubscribePositionsAckMessage,
  UnsubscribePositionsAckMessage,
  WorkingOrderPayload,
} from "../bridge/protocol.js";
import type { LiveBarEvent } from "./bus.js";

const SUBSCRIBE_TIMEOUT_MS = 15_000;
const UNSUBSCRIBE_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 10_000;
// Auto-resync after a seq gap: at most one in flight, spaced out.
const RESYNC_MIN_INTERVAL_MS = 5_000;
const CLOSED_TRADE_RING = 20;
const FILLS_PER_TRADE_CAP = 200;
const SEEN_EXECUTIONS_CAP = 2_000;

const RECOMPILE_HINT =
  "— the NT8 AddOn may predate subscribe_positions; recompile ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor (F5)";

// NT8 OrderState strings that end an order's life; anything else stays working.
const TERMINAL_ORDER_STATES = new Set(["Filled", "Cancelled", "Rejected", "Unknown"]);

/** Name-prefix heuristic — NT8 has no reliable sim-vs-live API, so callers
 *  surface this guess alongside the raw connection fields. */
export function looksLikeSimAccount(name: string): boolean {
  return /^(sim|playback|backtest|replay)/i.test(name);
}

/** Adverse excursion in points (≥ 0), null when unknown — "worst traded
 *  price vs the trade's final average" (the average moves on scale-ins). */
export function maePoints(
  direction: "long" | "short",
  averagePrice: number | null,
  maxAdversePrice: number | null,
): number | null {
  if (averagePrice === null || maxAdversePrice === null) return null;
  const sign = direction === "long" ? 1 : -1;
  return Math.max(0, sign * (averagePrice - maxAdversePrice));
}

/** Favorable excursion in points vs average entry (≥ 0), null when unknown. */
export function mfePoints(
  direction: "long" | "short",
  averagePrice: number | null,
  maxFavorablePrice: number | null,
): number | null {
  if (averagePrice === null || maxFavorablePrice === null) return null;
  const sign = direction === "long" ? 1 : -1;
  return Math.max(0, sign * (maxFavorablePrice - averagePrice));
}

export interface PriceMark {
  price: number;
  asOf: number; // unix seconds
  source: "bar" | "sync" | "fill";
}

export interface LiveTradeFill {
  time: number | null;
  side: string; // "Long" = buy, "Short" = sell (NT8 fill side)
  quantity: number;
  price: number | null;
  orderName?: string;
}

export interface LiveTradeState {
  account: string;
  instrument: string;
  symbol: string;
  direction: "long" | "short";
  /** null = position pre-existed the feed; age/entry facts are unknown. */
  openedAt: number | null;
  quantity: number;
  peakQuantity: number;
  averagePrice: number | null;
  // Raw price extremes while open; MAE/MFE derive vs averagePrice at read.
  maxFavorablePrice: number | null;
  maxAdversePrice: number | null;
  fills: LiveTradeFill[];
}

export interface ClosedTradeSummary {
  account: string;
  instrument: string;
  symbol: string;
  direction: "long" | "short";
  peakQuantity: number;
  openedAt: number | null;
  closedAt: number;
  entryPrice: number | null;
  exitPrice: number | null;
  /** dir-signed points vs last average entry — an approximation, not broker P&L. */
  approxRealizedPoints: number | null;
  maePoints: number | null;
  mfePoints: number | null;
  fillCount: number;
  preExisting: boolean;
  closeReason: "flat" | "reversal" | "sync" | "account-gone";
}

interface TrackedPosition extends PositionPayload {
  updatedAt: number; // unix seconds (server clock)
}

interface TrackedOrder extends WorkingOrderPayload {
  updatedAt: number;
}

interface AccountState {
  name: string;
  connection: string | null;
  connectionStatus: string | null;
  denomination: string | null;
  realizedPnl: number | null;
  cashValue: number | null;
  netLiquidation: number | null;
  positions: Map<string, TrackedPosition>; // by instrument
  orders: Map<string, TrackedOrder>; // by orderId (or composite fallback)
}

export type PositionBroadcast =
  | ({ type: "position_event" } & Omit<PositionEventMessage, "v" | "type">)
  | { type: "position_sync"; reason?: string; seq?: number; accountCount: number }
  | { type: "trade_closed"; trade: ClosedTradeSummary };

export interface PositionFeedDeps {
  db: Database;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  isConnected: () => boolean;
  nowUnix?: () => number;
  nowMs?: () => number;
  diagnosticsDir?: string;
  onBroadcast?: (b: PositionBroadcast) => void;
}

/** One account's live working state, JSON-shaped for /feed consumers. */
export interface AccountSnapshotView {
  name: string;
  connection: string | null;
  connectionStatus: string | null;
  positions: TrackedPosition[];
  orders: TrackedOrder[];
}

export interface PositionFeedStatus {
  desired: boolean;
  upstreamAcked: boolean;
  lastError: string | null;
  accountsTracked: number;
  openPositions: number;
  openTrades: number;
  lastSeq: number | null;
  seqGaps: number;
  eventsReceived: number;
  syncCount: number;
  executionsSeen: number;
  closedTradeCount: number;
  lastEventAt: number | null; // unix seconds
  lastSyncAt: number | null;
}

/**
 * Account-truth mirror over the NT8 bridge. Desired-state persists in sqlite
 * and replays on every hello (like the bar-feed registry); position_sync
 * replaces state wholesale, position_events mutate it, a seq gap triggers a
 * rate-limited pull resync. Trade lifecycle follows account transitions:
 * flat→open starts, open→flat ends, a direction flip splits.
 */
export class PositionFeed {
  private readonly deps: PositionFeedDeps;
  private readonly accounts = new Map<string, AccountState>();
  private readonly trades = new Map<string, LiveTradeState>(); // account|instrument
  private readonly closedTrades: ClosedTradeSummary[] = [];
  private readonly lastPrices = new Map<string, PriceMark>(); // by symbol
  private readonly seenExecutions = new Set<string>();
  private readonly seenExecutionOrder: string[] = [];

  private desiredOn = false;
  private upstreamAcked = false;
  private lastError: string | null = null;
  private lastSeq: number | null = null;
  private seqGaps = 0;
  private eventsReceived = 0;
  private syncCount = 0;
  private executionsSeen = 0;
  private lastEventAt: number | null = null;
  private lastSyncAt: number | null = null;
  private lastResyncAtMs = 0;
  private resyncInFlight = false;
  private diagDirReady = false;

  constructor(deps: PositionFeedDeps) {
    this.deps = deps;
  }

  private nowUnix(): number {
    return this.deps.nowUnix ? this.deps.nowUnix() : Math.floor(Date.now() / 1000);
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  // ---------- desired state + upstream control ----------

  loadPersisted(): void {
    const row = this.deps.db
      .prepare("SELECT enabled FROM live_position_feed WHERE id = 1")
      .get() as { enabled: number } | undefined;
    this.desiredOn = row ? row.enabled === 1 : false;
  }

  desired(): boolean {
    return this.desiredOn;
  }

  private persistDesired(): void {
    this.deps.db
      .prepare(
        `INSERT INTO live_position_feed (id, enabled, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(this.desiredOn ? 1 : 0, this.nowUnix());
  }

  async subscribe(): Promise<{
    ok: boolean;
    accounts: string[];
    alreadyActive: boolean;
    error?: string;
  }> {
    this.desiredOn = true;
    this.persistDesired();
    if (!this.deps.isConnected()) {
      this.upstreamAcked = false;
      this.lastError =
        "NinjaTrader bridge not connected — position feed recorded and will activate on next hello.";
      return { ok: false, accounts: [], alreadyActive: false, error: this.lastError };
    }
    return this.subscribeUpstream();
  }

  private async subscribeUpstream(): Promise<{
    ok: boolean;
    accounts: string[];
    alreadyActive: boolean;
    error?: string;
  }> {
    try {
      const res = (await this.deps.request(
        "subscribe_positions",
        {},
        SUBSCRIBE_TIMEOUT_MS,
      )) as SubscribePositionsAckMessage;
      this.upstreamAcked = true;
      this.lastError = null;
      return { ok: true, accounts: res.accounts ?? [], alreadyActive: res.alreadyActive === true };
    } catch (err) {
      let m = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(m)) m = `${m} ${RECOMPILE_HINT}`;
      this.upstreamAcked = false;
      this.lastError = m;
      return { ok: false, accounts: [], alreadyActive: false, error: m };
    }
  }

  async unsubscribe(): Promise<{ ok: boolean; removed: boolean; error?: string }> {
    this.desiredOn = false;
    this.persistDesired();
    this.upstreamAcked = false;
    if (!this.deps.isConnected()) {
      // Desired OFF is durable; replay() enforces it on the next hello.
      return { ok: true, removed: false };
    }
    try {
      const res = (await this.deps.request(
        "unsubscribe_positions",
        {},
        UNSUBSCRIBE_TIMEOUT_MS,
      )) as UnsubscribePositionsAckMessage;
      return { ok: true, removed: res.removed === true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // Desired OFF is persisted; replay() re-enforces on next hello.
      return { ok: true, removed: false, error: m };
    }
  }

  /** Enforce desired state on the AddOn after (re)connect. Called per hello. */
  async replay(): Promise<void> {
    if (!this.deps.isConnected()) return;
    if (this.desiredOn) {
      const res = await this.subscribeUpstream();
      if (!res.ok) {
        console.error(`[position-feed] hello replay subscribe failed: ${res.error}`);
      }
    } else {
      // The AddOn keeps streaming across WS reconnects — enforce OFF in case
      // the feed was disabled while it was unreachable.
      try {
        await this.deps.request("unsubscribe_positions", {}, UNSUBSCRIBE_TIMEOUT_MS);
      } catch {
        // old AddOn or transient failure — next hello retries
      }
    }
  }

  // ---------- pull snapshot ----------

  /**
   * Round-trip request_positions and fold the response in as authority.
   * Responses bypass the seq-ordered queue, so a pull can race a newer
   * event — harmless: payloads are absolute values (never deltas), so the
   * next event/sync reconverges.
   */
  async pull(): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.isConnected()) {
      return { ok: false, error: "NinjaTrader bridge not connected" };
    }
    try {
      const res = (await this.deps.request(
        "request_positions",
        {},
        PULL_TIMEOUT_MS,
      )) as PositionsResponseMessage;
      this.applySnapshot(res.accounts ?? [], "pull", this.nowUnix());
      return { ok: true };
    } catch (err) {
      let m = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(m)) m = `${m} ${RECOMPILE_HINT}`;
      return { ok: false, error: m };
    }
  }

  // ---------- inbound: sync ----------

  handleSync(msg: PositionSyncMessage): void {
    this.syncCount++;
    this.lastSyncAt = this.nowUnix();
    this.noteStreamAlive();
    if (typeof msg.seq === "number") this.noteSeq(msg.seq);
    this.applySnapshot(msg.accounts, msg.reason ?? "sync", msg.ts ?? this.nowUnix());
    this.appendDiagnostics({ t: "sync", reason: msg.reason, seq: msg.seq, ts: msg.ts });
    this.broadcast({
      type: "position_sync",
      ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
      ...(typeof msg.seq === "number" ? { seq: msg.seq } : {}),
      accountCount: msg.accounts.length,
    });
  }

  private applySnapshot(
    accounts: AccountSnapshotPayload[],
    reason: string,
    asOf: number,
  ): void {
    const seen = new Set<string>();
    for (const snap of accounts) {
      seen.add(snap.name);
      const state = this.freshAccountState(snap, asOf);
      this.accounts.set(snap.name, state);

      // Feed price marks from best-effort snapshot market data.
      for (const p of snap.positions) {
        if (typeof p.marketPrice === "number" && p.symbol) {
          this.notePrice(p.symbol, {
            price: p.marketPrice,
            asOf: typeof p.marketPriceTs === "number" ? p.marketPriceTs : asOf,
            source: "sync",
          });
        }
      }
      this.reconcileTradesForAccount(snap.name, state, asOf);
    }

    // Vanished accounts (roster change): close their trades, drop the state.
    for (const [name] of this.accounts) {
      if (seen.has(name)) continue;
      for (const [key, trade] of [...this.trades]) {
        if (trade.account !== name) continue;
        this.closeTrade(key, trade, asOf, null, "account-gone");
      }
      this.accounts.delete(name);
    }
  }

  private freshAccountState(snap: AccountSnapshotPayload, asOf: number): AccountState {
    const positions = new Map<string, TrackedPosition>();
    for (const p of snap.positions) {
      if (p.marketPosition === "Flat" || p.quantity === 0) continue;
      positions.set(p.instrument, { ...p, updatedAt: asOf });
    }
    const orders = new Map<string, TrackedOrder>();
    for (const o of snap.orders) {
      orders.set(this.orderKey(o), { ...o, updatedAt: asOf });
    }
    return {
      name: snap.name,
      connection: snap.connection ?? null,
      connectionStatus: snap.connectionStatus ?? null,
      denomination: snap.denomination ?? null,
      realizedPnl: snap.realizedPnl ?? null,
      cashValue: snap.cashValue ?? null,
      netLiquidation: snap.netLiquidation ?? null,
      positions,
      orders,
    };
  }

  /** Snapshot truth vs live-trade state: open missing trades as pre-existing,
   *  close trades whose position is gone, flip direction mismatches. */
  private reconcileTradesForAccount(
    account: string,
    state: AccountState,
    asOf: number,
  ): void {
    for (const [instrument, pos] of state.positions) {
      const key = this.tradeKey(account, instrument);
      const dir = pos.marketPosition === "Short" ? "short" : "long";
      const existing = this.trades.get(key);
      if (!existing) {
        this.trades.set(key, this.freshTrade(account, pos, dir, null));
        continue;
      }
      if (existing.direction !== dir) {
        this.closeTrade(key, existing, asOf, this.lastPriceFor(pos.symbol), "sync");
        this.trades.set(key, this.freshTrade(account, pos, dir, null));
        continue;
      }
      existing.quantity = pos.quantity;
      existing.peakQuantity = Math.max(existing.peakQuantity, pos.quantity);
      if (typeof pos.averagePrice === "number") existing.averagePrice = pos.averagePrice;
    }
    for (const [key, trade] of [...this.trades]) {
      if (trade.account !== account) continue;
      if (state.positions.has(trade.instrument)) continue;
      this.closeTrade(key, trade, asOf, this.lastPriceFor(trade.symbol), "sync");
    }
  }

  // ---------- inbound: events ----------

  handleEvent(msg: PositionEventMessage): void {
    this.eventsReceived++;
    this.lastEventAt = this.nowUnix();
    this.noteStreamAlive();
    if (typeof msg.seq === "number") this.noteSeq(msg.seq);
    const ts = typeof msg.ts === "number" ? msg.ts : this.nowUnix();

    if (msg.kind === "position" && msg.position) {
      this.applyPositionEvent(msg.account, msg.position, ts);
    } else if (msg.kind === "order" && msg.order) {
      this.applyOrderEvent(msg.account, msg.order, ts);
    } else if (msg.kind === "execution" && msg.execution) {
      this.applyExecutionEvent(msg.account, msg.execution, ts);
    }

    this.appendDiagnostics({ t: "event", ...msg });
    const { v: _v, type: _type, ...rest } = msg;
    this.broadcast({ type: "position_event", ...rest });
  }

  private ensureAccount(name: string): AccountState {
    let state = this.accounts.get(name);
    if (!state) {
      state = {
        name,
        connection: null,
        connectionStatus: null,
        denomination: null,
        realizedPnl: null,
        cashValue: null,
        netLiquidation: null,
        positions: new Map(),
        orders: new Map(),
      };
      this.accounts.set(name, state);
    }
    return state;
  }

  private applyPositionEvent(account: string, pos: PositionPayload, ts: number): void {
    const state = this.ensureAccount(account);
    const key = this.tradeKey(account, pos.instrument);
    const isFlat = pos.marketPosition === "Flat" || pos.quantity === 0;

    if (isFlat) {
      state.positions.delete(pos.instrument);
      const trade = this.trades.get(key);
      if (trade) this.closeTrade(key, trade, ts, this.lastPriceFor(pos.symbol), "flat");
      return;
    }

    state.positions.set(pos.instrument, { ...pos, updatedAt: ts });
    const dir = pos.marketPosition === "Short" ? "short" : "long";
    const trade = this.trades.get(key);
    if (!trade) {
      this.trades.set(key, this.freshTrade(account, pos, dir, ts));
      return;
    }
    if (trade.direction !== dir) {
      // Reversal without touching flat: one trade ends, the next begins.
      this.closeTrade(key, trade, ts, this.lastPriceFor(pos.symbol), "reversal");
      this.trades.set(key, this.freshTrade(account, pos, dir, ts));
      return;
    }
    trade.quantity = pos.quantity;
    trade.peakQuantity = Math.max(trade.peakQuantity, pos.quantity);
    if (typeof pos.averagePrice === "number") trade.averagePrice = pos.averagePrice;
  }

  private applyOrderEvent(account: string, order: WorkingOrderPayload, ts: number): void {
    const state = this.ensureAccount(account);
    const key = this.orderKey(order);
    if (TERMINAL_ORDER_STATES.has(order.state)) {
      state.orders.delete(key);
    } else {
      state.orders.set(key, { ...order, updatedAt: ts });
    }
  }

  private applyExecutionEvent(account: string, exec: ExecutionPayload, ts: number): void {
    // Brokers replay executions on reconnect — dedupe by id.
    if (exec.executionId) {
      if (this.seenExecutions.has(exec.executionId)) return;
      this.seenExecutions.add(exec.executionId);
      this.seenExecutionOrder.push(exec.executionId);
      if (this.seenExecutionOrder.length > SEEN_EXECUTIONS_CAP) {
        const evicted = this.seenExecutionOrder.shift();
        if (evicted) this.seenExecutions.delete(evicted);
      }
    }
    this.executionsSeen++;

    if (typeof exec.price === "number" && exec.symbol) {
      this.notePrice(exec.symbol, {
        price: exec.price,
        asOf: typeof exec.time === "number" ? exec.time : ts,
        source: "fill",
      });
    }

    const trade = this.trades.get(this.tradeKey(account, exec.instrument));
    if (!trade) return;
    if (trade.fills.length < FILLS_PER_TRADE_CAP) {
      trade.fills.push({
        time: typeof exec.time === "number" ? exec.time : null,
        side: exec.side,
        quantity: exec.quantity,
        price: typeof exec.price === "number" ? exec.price : null,
        ...(exec.orderName ? { orderName: exec.orderName } : {}),
      });
    }
    if (typeof exec.price === "number") this.extendExcursion(trade, exec.price, exec.price);
  }

  // ---------- seq / resync ----------

  /** Stream traffic proves the AddOn is streaming — reconciles a lost ack.
   *  Desired-gated so a stray stream after a failed OFF never claims acked. */
  private noteStreamAlive(): void {
    if (this.desiredOn && !this.upstreamAcked) {
      this.upstreamAcked = true;
      this.lastError = null;
    }
  }

  private noteSeq(seq: number): void {
    if (this.lastSeq !== null && seq > this.lastSeq + 1) {
      this.seqGaps++;
      console.error(
        `[position-feed] seq gap (${this.lastSeq} -> ${seq}) — scheduling resync`,
      );
      this.scheduleResync();
    }
    // seq < lastSeq means the AddOn restarted its counter; just re-anchor.
    this.lastSeq = seq;
  }

  private scheduleResync(): void {
    const now = this.nowMs();
    if (this.resyncInFlight || now - this.lastResyncAtMs < RESYNC_MIN_INTERVAL_MS) return;
    this.resyncInFlight = true;
    this.lastResyncAtMs = now;
    void this.pull()
      .then((r) => {
        if (!r.ok) console.error(`[position-feed] gap resync failed: ${r.error}`);
      })
      .finally(() => {
        this.resyncInFlight = false;
      });
  }

  // ---------- live bar integration ----------

  /** Fold live bar closes into price marks and open-trade excursions. */
  noteBar(e: LiveBarEvent): void {
    if (e.backfill) return; // stale catch-up bars must not move "current" price
    this.notePrice(e.symbol, {
      price: e.candle.close,
      asOf: Math.floor(e.receivedAtMs / 1000),
      source: "bar",
    });
    for (const trade of this.trades.values()) {
      if (trade.symbol !== e.symbol) continue;
      this.extendExcursion(trade, e.candle.high, e.candle.low);
    }
  }

  private notePrice(symbol: string, mark: PriceMark): void {
    const prev = this.lastPrices.get(symbol);
    if (prev && prev.asOf > mark.asOf) return;
    this.lastPrices.set(symbol, mark);
  }

  lastPriceFor(symbol: string): PriceMark | null {
    return this.lastPrices.get(symbol) ?? null;
  }

  private extendExcursion(trade: LiveTradeState, high: number, low: number): void {
    if (trade.direction === "long") {
      trade.maxFavorablePrice =
        trade.maxFavorablePrice === null ? high : Math.max(trade.maxFavorablePrice, high);
      trade.maxAdversePrice =
        trade.maxAdversePrice === null ? low : Math.min(trade.maxAdversePrice, low);
    } else {
      trade.maxFavorablePrice =
        trade.maxFavorablePrice === null ? low : Math.min(trade.maxFavorablePrice, low);
      trade.maxAdversePrice =
        trade.maxAdversePrice === null ? high : Math.max(trade.maxAdversePrice, high);
    }
  }

  // ---------- trade lifecycle ----------

  private tradeKey(account: string, instrument: string): string {
    return `${account}|${instrument}`;
  }

  private orderKey(o: WorkingOrderPayload): string {
    if (o.orderId) return o.orderId;
    return `noid:${o.name}:${o.instrument}:${o.action}:${o.time ?? 0}`;
  }

  private freshTrade(
    account: string,
    pos: PositionPayload,
    direction: "long" | "short",
    openedAt: number | null,
  ): LiveTradeState {
    const avg = typeof pos.averagePrice === "number" ? pos.averagePrice : null;
    return {
      account,
      instrument: pos.instrument,
      symbol: pos.symbol,
      direction,
      openedAt,
      quantity: pos.quantity,
      peakQuantity: pos.quantity,
      averagePrice: avg,
      maxFavorablePrice: avg,
      maxAdversePrice: avg,
      fills: [],
    };
  }

  private closeTrade(
    key: string,
    trade: LiveTradeState,
    closedAt: number,
    exitMark: PriceMark | null,
    reason: ClosedTradeSummary["closeReason"],
  ): void {
    this.trades.delete(key);
    const dirSign = trade.direction === "long" ? 1 : -1;
    // Event closes: the last fill IS the exit (execution lands just before
    // the position event). Sync closes: the feed was blind, recorded fills
    // may be entries — trust only the price mark.
    let exitPrice: number | null = null;
    if (reason === "flat" || reason === "reversal") {
      for (let i = trade.fills.length - 1; i >= 0; i--) {
        const p = trade.fills[i].price;
        if (typeof p === "number") {
          exitPrice = p;
          break;
        }
      }
    }
    if (exitPrice === null && exitMark) exitPrice = exitMark.price;

    const entry = trade.averagePrice;
    const summary: ClosedTradeSummary = {
      account: trade.account,
      instrument: trade.instrument,
      symbol: trade.symbol,
      direction: trade.direction,
      peakQuantity: trade.peakQuantity,
      openedAt: trade.openedAt,
      closedAt,
      entryPrice: entry,
      exitPrice,
      approxRealizedPoints:
        entry !== null && exitPrice !== null ? dirSign * (exitPrice - entry) : null,
      maePoints: maePoints(trade.direction, entry, trade.maxAdversePrice),
      mfePoints: mfePoints(trade.direction, entry, trade.maxFavorablePrice),
      fillCount: trade.fills.length,
      preExisting: trade.openedAt === null,
      closeReason: reason,
    };
    this.closedTrades.push(summary);
    if (this.closedTrades.length > CLOSED_TRADE_RING) this.closedTrades.shift();
    this.broadcast({ type: "trade_closed", trade: summary });
  }

  // ---------- read model ----------

  status(): PositionFeedStatus {
    let openPositions = 0;
    for (const a of this.accounts.values()) openPositions += a.positions.size;
    return {
      desired: this.desiredOn,
      upstreamAcked: this.upstreamAcked,
      lastError: this.lastError,
      accountsTracked: this.accounts.size,
      openPositions,
      openTrades: this.trades.size,
      lastSeq: this.lastSeq,
      seqGaps: this.seqGaps,
      eventsReceived: this.eventsReceived,
      syncCount: this.syncCount,
      executionsSeen: this.executionsSeen,
      closedTradeCount: this.closedTrades.length,
      lastEventAt: this.lastEventAt,
      lastSyncAt: this.lastSyncAt,
    };
  }

  accountsView(): AccountState[] {
    return [...this.accounts.values()];
  }

  /** Plain-array view for the consumer channel (AccountState's Maps stay
   *  private). Orders are re-filtered defensively — a terminal state must
   *  never leak to a reconciling consumer as "working". */
  snapshotView(): AccountSnapshotView[] {
    return [...this.accounts.values()].map((a) => ({
      name: a.name,
      connection: a.connection,
      connectionStatus: a.connectionStatus,
      positions: [...a.positions.values()],
      orders: [...a.orders.values()].filter((o) => !TERMINAL_ORDER_STATES.has(o.state)),
    }));
  }

  openTrades(): LiveTradeState[] {
    return [...this.trades.values()];
  }

  tradeFor(account: string, instrument: string): LiveTradeState | null {
    return this.trades.get(this.tradeKey(account, instrument)) ?? null;
  }

  recentClosedTrades(): ClosedTradeSummary[] {
    return [...this.closedTrades].reverse(); // newest first
  }

  // ---------- diagnostics / broadcast ----------

  private broadcast(b: PositionBroadcast): void {
    if (!this.deps.onBroadcast) return;
    try {
      this.deps.onBroadcast(b);
    } catch (err) {
      console.error("[position-feed] broadcast handler error:", err);
    }
  }

  private appendDiagnostics(obj: Record<string, unknown>): void {
    const dir = this.deps.diagnosticsDir;
    if (!dir) return;
    try {
      if (!this.diagDirReady) {
        mkdirSync(dir, { recursive: true });
        this.diagDirReady = true;
      }
      const day = new Date(this.nowMs()).toISOString().slice(0, 10);
      appendFileSync(
        join(dir, `position-events-${day}.jsonl`),
        `${JSON.stringify({ atMs: this.nowMs(), ...obj })}\n`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[position-feed] jsonl append failed: ${m}`);
    }
  }
}

export type { AccountState as PositionAccountState, TrackedOrder, TrackedPosition };
