import type { WebSocket } from "ws";
import { LIVE_TIMEFRAMES } from "../core/constants.js";
import { ORDER_ACTIONS, ORDER_TIFS, ORDER_TYPES } from "./protocol.js";
import type { EnsureResult, LiveSubState, LiveTimeframe } from "../live/registry.js";
import type { Bus, LiveBarEvent, LiveFeedBus } from "../live/bus.js";
import type { AccountSnapshotView, PositionBroadcast } from "../live/positions.js";
import type {
  CancelAllResult,
  CancelResult,
  ChangeResult,
  FlattenResult,
  OcoResult,
  OrderAction,
  OrderResult,
  OrderTypeName,
  TimeInForce,
} from "../execution/types.js";
import { SERVER_VERSION } from "./server.js";

// Consumers whose socket buffer exceeds this are dropped (stuck-bot guard).
const MAX_BUFFERED_BYTES = 4_000_000;

// Bounds one ensure_bars request's worth of NT8 history fetches.
const MAX_ENSURE_RANGE_SECS = 45 * 86_400;

/** EnsureCachedResult's counters without per-day classification internals. */
export interface EnsureBarsSummary {
  ok: boolean;
  daysChecked: number;
  windowsFetched: number;
  windowsFailed: number;
  bridgeDisconnected: boolean;
  simFeedRejected: boolean;
  errors: Array<{ window: string; message: string }>;
  /** Catastrophic failure (unknown symbol, handler threw) — counters are zeros. */
  error?: string;
}

/** Write gateway as the hub sees it (structurally ExecutionService) — every
 *  /feed order op delegates here, so bot orders pass through the same
 *  fail-closed gates and audit trail as MCP-tool orders. No separate
 *  registration gate: cancel/flatten must keep working even when the
 *  runtime gate blocks new risk. */
export interface ExecutionBinding {
  submit(intent: {
    account: string;
    symbol: string;
    action: OrderAction;
    orderType: OrderTypeName;
    quantity: number;
    limitPrice?: number;
    stopPrice?: number;
    tif: TimeInForce;
    clientOrderId?: string;
    source: string;
    reason?: string;
  }): Promise<OrderResult>;
  submitOco(intent: {
    account: string;
    symbol: string;
    action: OrderAction;
    quantity: number;
    stopPrice: number;
    limitPrice: number;
    tif: TimeInForce;
    clientOrderId?: string;
    source: string;
    reason?: string;
  }): Promise<OcoResult>;
  cancel(intent: {
    account: string;
    clientOrderId: string;
    source: string;
    reason?: string;
  }): Promise<CancelResult>;
  cancelAll(intent: {
    account: string;
    symbol: string;
    source: string;
    reason?: string;
  }): Promise<CancelAllResult>;
  flatten(intent: {
    account: string;
    symbol: string;
    source: string;
    reason?: string;
  }): Promise<FlattenResult>;
  change(intent: {
    account: string;
    clientOrderId: string;
    quantity?: number;
    limitPrice?: number;
    stopPrice?: number;
    source: string;
    reason?: string;
  }): Promise<ChangeResult>;
}

export interface ConsumerHubBinding {
  ensure: (
    symbol: string,
    timeframe: LiveTimeframe,
    source: string,
  ) => Promise<EnsureResult>;
  release: (
    symbol: string,
    timeframe: LiveTimeframe,
    source: string,
  ) => Promise<{ removedUpstream: boolean; pendingUpstreamRelease?: boolean }>;
  releaseAllForSource: (source: string) => Promise<void>;
  list: () => LiveSubState[];
  /** Fill cache gaps for (fromUnix, toUnix] at a raw TF via the get_candles
   *  fill path — a bot's self-serve warm-up. Read-path only. */
  ensureBars: (
    symbol: string,
    timeframe: LiveTimeframe,
    fromUnix: number,
    toUnix: number,
  ) => Promise<EnsureBarsSummary>;
}

interface ConsumerConn {
  id: string;
  ws: WebSocket;
  keys: Set<string>;
  // Opted into position broadcasts (position_event/position_sync/trade_closed).
  positions: boolean;
  // One ensure_bars in flight per consumer; overlap is refused, not queued.
  ensureInFlight: boolean;
  // Same rule for sync_positions (a fresh pull round-trips NT8).
  syncInFlight: boolean;
}

/**
 * The /feed side of the bridge server: local consumers (bots, dashboards)
 * subscribe to live bars over WS with the same bearer token as the addon.
 * A consumer subscribe also creates the upstream NT8 subscription, so a bot
 * is self-sufficient. Constructed unbound; the live runtime binds registry +
 * bus at startup — before that, subscribes answer with an error.
 */
// Message types routed to the execution gateway (reply: `<type>_result`).
const WRITE_OPS = new Set([
  "place_order",
  "place_oco",
  "cancel_order",
  "cancel_all",
  "flatten",
  "change_order",
]);

function fStr(msg: Record<string, unknown>, key: string): string | undefined {
  const v = msg[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function fNum(msg: Record<string, unknown>, key: string): number | undefined {
  const v = msg[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function fEnum<T extends string>(
  msg: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = msg[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

/** Read surface the live runtime lends to /feed for account-truth queries:
 *  `pull` round-trips NT8 for a refresh, `snapshot` reads the current mirror. */
export interface PositionsBinding {
  status: () => { desired: boolean; upstreamAcked: boolean; lastSyncAt: number | null };
  snapshot: () => AccountSnapshotView[];
  pull: () => Promise<{ ok: boolean; error?: string }>;
}

export class ConsumerHub {
  private binding: ConsumerHubBinding | null = null;
  private execution: ExecutionBinding | null = null;
  private busUnsubscribe: (() => void) | null = null;
  private positionBusUnsubscribe: (() => void) | null = null;
  private positionsBinding: PositionsBinding | null = null;
  private readonly consumers = new Map<string, ConsumerConn>();
  private nextId = 1;

  bind(binding: ConsumerHubBinding, bus: LiveFeedBus): void {
    this.binding = binding;
    if (this.busUnsubscribe) this.busUnsubscribe();
    this.busUnsubscribe = bus.subscribe((e) => this.broadcast(e));
  }

  /** Bound from server.ts so bridge/ never imports execution/ directly. */
  bindExecution(execution: ExecutionBinding | null): void {
    this.execution = execution;
  }

  /** Position broadcasts are receive-only (operator owns the toggle) — bots
   *  only get events while the feed is on. Also lends the snapshot/pull
   *  surface that answers sync_positions on request. */
  bindPositions(bus: Bus<PositionBroadcast>, binding: PositionsBinding | null): void {
    this.positionsBinding = binding;
    if (this.positionBusUnsubscribe) this.positionBusUnsubscribe();
    this.positionBusUnsubscribe = bus.subscribe((b) => this.broadcastPosition(b));
  }

  attach(ws: WebSocket): void {
    const id = `consumer:${this.nextId++}`;
    const conn: ConsumerConn = {
      id,
      ws,
      keys: new Set(),
      positions: false,
      ensureInFlight: false,
      syncInFlight: false,
    };
    this.consumers.set(id, conn);

    this.send(conn, {
      type: "welcome",
      serverVersion: SERVER_VERSION,
      subscriptions: this.binding ? this.binding.list() : [],
    });

    ws.on("message", (data) => {
      void this.handleMessage(conn, data.toString()).catch((err) => {
        console.error(`[feed] ${id} message handling failed:`, err);
      });
    });
    ws.on("close", () => {
      this.consumers.delete(id);
      const binding = this.binding;
      if (binding) {
        void Promise.resolve()
          .then(() => binding.releaseAllForSource(id))
          .catch((err) => console.error(`[feed] ${id} release failed:`, err));
      }
      console.error(`[feed] ${id} disconnected (${this.consumers.size} remaining)`);
    });
    ws.on("error", (err) => console.error(`[feed] ${id} socket error:`, err.message));

    console.error(`[feed] ${id} connected (${this.consumers.size} total)`);
  }

  count(): number {
    return this.consumers.size;
  }

  stop(): void {
    for (const conn of this.consumers.values()) {
      try {
        conn.ws.close(1001, "server shutdown");
      } catch {
        // ignore
      }
    }
    this.consumers.clear();
  }

  private broadcast(e: LiveBarEvent): void {
    if (this.consumers.size === 0) return;
    const key = `${e.symbol}:${e.timeframe}`;
    let payload: string | null = null;
    for (const conn of this.consumers.values()) {
      if (!conn.keys.has(key)) continue;
      if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        console.error(`[feed] ${conn.id} backpressure limit hit — dropping consumer`);
        try {
          conn.ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      payload ??= JSON.stringify({ type: "bar", ...e });
      try {
        conn.ws.send(payload);
      } catch (err) {
        console.error(`[feed] ${conn.id} send failed:`, err);
      }
    }
  }

  // Same backpressure guard as bars; the payload's own type field
  // ("position_event" | "position_sync" | "trade_closed") discriminates.
  private broadcastPosition(b: PositionBroadcast): void {
    if (this.consumers.size === 0) return;
    let payload: string | null = null;
    for (const conn of this.consumers.values()) {
      if (!conn.positions) continue;
      if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        console.error(`[feed] ${conn.id} backpressure limit hit — dropping consumer`);
        try {
          conn.ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      payload ??= JSON.stringify(b);
      try {
        conn.ws.send(payload);
      } catch (err) {
        console.error(`[feed] ${conn.id} send failed:`, err);
      }
    }
  }

  private async handleMessage(conn: ConsumerConn, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.send(conn, { type: "error", message: "invalid JSON" });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      this.send(conn, { type: "error", message: "missing type" });
      return;
    }

    if (typeof msg.type === "string" && WRITE_OPS.has(msg.type)) {
      await this.handleWriteOp(conn, msg);
      return;
    }

    switch (msg.type) {
      case "ping":
        this.send(conn, { type: "pong" });
        return;
      case "subscribe_positions": {
        conn.positions = true;
        const feed = this.positionsBinding
          ? this.positionsBinding.status()
          : { desired: false, upstreamAcked: false };
        this.send(conn, {
          type: "subscribed_positions",
          ok: true,
          // Receive-only: events flow only while the operator-owned feed is on.
          feedDesired: feed.desired,
          feedUpstreamAcked: feed.upstreamAcked,
          ...(feed.desired
            ? {}
            : {
                note: "position feed is OFF — ask the operator to run subscribe_live_positions",
              }),
        });
        return;
      }
      case "unsubscribe_positions": {
        conn.positions = false;
        this.send(conn, { type: "unsubscribed_positions", ok: true });
        return;
      }
      case "ensure_bars": {
        // Every outcome (validation included) answers as ensure_bars_result
        // with reqId echoed, so a bot can await it.
        const reqId = typeof msg.reqId === "string" ? msg.reqId : null;
        const fail = (message: string): void =>
          this.send(conn, {
            type: "ensure_bars_result",
            ...(reqId !== null ? { reqId } : {}),
            ok: false,
            error: message,
          });
        const { symbol, timeframe, fromUnix, toUnix } = msg;
        if (typeof symbol !== "string" || symbol.length === 0) {
          fail("ensure_bars: missing symbol");
          return;
        }
        if (
          typeof timeframe !== "string" ||
          !LIVE_TIMEFRAMES.includes(timeframe as LiveTimeframe)
        ) {
          fail(`ensure_bars: timeframe must be one of ${LIVE_TIMEFRAMES.join(", ")}`);
          return;
        }
        if (
          typeof fromUnix !== "number" ||
          typeof toUnix !== "number" ||
          !Number.isInteger(fromUnix) ||
          !Number.isInteger(toUnix) ||
          fromUnix >= toUnix
        ) {
          fail("ensure_bars: fromUnix/toUnix must be integers with fromUnix < toUnix");
          return;
        }
        if (toUnix - fromUnix > MAX_ENSURE_RANGE_SECS) {
          fail(
            `ensure_bars: range exceeds ${MAX_ENSURE_RANGE_SECS / 86_400} days — split the request`,
          );
          return;
        }
        if (!this.binding) {
          fail("live feed runtime not started");
          return;
        }
        if (conn.ensureInFlight) {
          fail("ensure_bars already in flight for this consumer");
          return;
        }
        conn.ensureInFlight = true;
        try {
          const summary = await this.binding.ensureBars(
            symbol,
            timeframe as LiveTimeframe,
            fromUnix,
            toUnix,
          );
          this.send(conn, {
            type: "ensure_bars_result",
            ...(reqId !== null ? { reqId } : {}),
            symbol,
            timeframe,
            ...summary,
          });
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        } finally {
          conn.ensureInFlight = false;
        }
        return;
      }
      case "sync_positions": {
        // Full snapshot on request (position_sync broadcast is just a
        // doorbell). fresh:true round-trips NT8 first for venue truth.
        const reqId = typeof msg.reqId === "string" ? msg.reqId : null;
        const fail = (message: string): void =>
          this.send(conn, {
            type: "sync_positions_result",
            ...(reqId !== null ? { reqId } : {}),
            ok: false,
            error: message,
          });
        const positionsBinding = this.positionsBinding;
        if (!positionsBinding) {
          fail("position feed not bound — live runtime not started");
          return;
        }
        if (conn.syncInFlight) {
          fail("sync_positions already in flight for this consumer");
          return;
        }
        const account = fStr(msg, "account");
        conn.syncInFlight = true;
        try {
          let pulled = false;
          let pullError: string | undefined;
          if (msg.fresh === true) {
            const res = await positionsBinding.pull();
            pulled = res.ok;
            pullError = res.error;
          }
          const feed = positionsBinding.status();
          const accounts = positionsBinding
            .snapshot()
            .filter((a) => account === undefined || a.name === account);
          this.send(conn, {
            type: "sync_positions_result",
            ...(reqId !== null ? { reqId } : {}),
            ok: true,
            feedDesired: feed.desired,
            feedUpstreamAcked: feed.upstreamAcked,
            lastSyncAtUnix: feed.lastSyncAt,
            pulled,
            ...(pullError !== undefined ? { pullError } : {}),
            accounts,
          });
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        } finally {
          conn.syncInFlight = false;
        }
        return;
      }
      case "subscribe":
      case "unsubscribe": {
        const symbol = msg.symbol;
        const timeframe = msg.timeframe;
        if (typeof symbol !== "string" || symbol.length === 0) {
          this.send(conn, { type: "error", message: `${msg.type}: missing symbol` });
          return;
        }
        if (
          typeof timeframe !== "string" ||
          !LIVE_TIMEFRAMES.includes(timeframe as LiveTimeframe)
        ) {
          this.send(conn, {
            type: "error",
            message: `${msg.type}: timeframe must be one of ${LIVE_TIMEFRAMES.join(", ")}`,
          });
          return;
        }
        if (!this.binding) {
          this.send(conn, { type: "error", message: "live feed runtime not started" });
          return;
        }
        const key = `${symbol}:${timeframe}`;
        if (msg.type === "subscribe") {
          conn.keys.add(key);
          const res = await this.binding.ensure(
            symbol,
            timeframe as LiveTimeframe,
            conn.id,
          );
          this.send(conn, {
            type: "subscribed",
            ok: res.ok,
            symbol,
            timeframe,
            upstream: {
              acked: res.state.acked,
              contract: res.state.contract,
              error: res.error ?? null,
            },
          });
        } else {
          conn.keys.delete(key);
          const res = await this.binding.release(symbol, timeframe as LiveTimeframe, conn.id);
          this.send(conn, {
            type: "unsubscribed",
            symbol,
            timeframe,
            upstreamReleased: res.removedUpstream,
            ...(res.pendingUpstreamRelease ? { pendingUpstreamRelease: true } : {}),
          });
        }
        return;
      }
      default:
        this.send(conn, { type: "error", message: `unknown type: ${msg.type}` });
    }
  }

  /** Extract → delegate to the execution gateway → echo its result verbatim.
   *  `source` is server-derived (`feed:<consumer id>`) so a bot can never
   *  masquerade as an MCP tool in the audit trail. */
  private async handleWriteOp(conn: ConsumerConn, msg: Record<string, unknown>): Promise<void> {
    const op = msg.type as string;
    const reqId = typeof msg.reqId === "string" ? msg.reqId : null;
    const reply = (payload: Record<string, unknown>): void =>
      this.send(conn, { type: `${op}_result`, ...(reqId !== null ? { reqId } : {}), ...payload });

    const exec = this.execution;
    if (!exec) {
      reply({ ok: false, error: "execution gateway not wired", certainlyNotSubmitted: true });
      return;
    }
    const source = `feed:${conn.id}`;
    const account = fStr(msg, "account") ?? "";
    const symbol = fStr(msg, "symbol") ?? "";
    const clientOrderId = fStr(msg, "clientOrderId");
    const reason = fStr(msg, "reason");
    const reasonPart = reason !== undefined ? { reason } : {};

    try {
      switch (op) {
        case "place_order": {
          const action = fEnum(msg, "action", ORDER_ACTIONS);
          const orderType = fEnum(msg, "orderType", ORDER_TYPES);
          const tif = fEnum(msg, "tif", ORDER_TIFS);
          if (!action || !orderType || !tif) {
            reply({
              ok: false,
              error: `place_order needs action ∈ ${ORDER_ACTIONS.join("|")}, orderType ∈ ${ORDER_TYPES.join("|")}, tif ∈ ${ORDER_TIFS.join("|")}`,
              certainlyNotSubmitted: true,
            });
            return;
          }
          const limitPrice = fNum(msg, "limitPrice");
          const stopPrice = fNum(msg, "stopPrice");
          const result = await exec.submit({
            account,
            symbol,
            action,
            orderType,
            quantity: fNum(msg, "quantity") ?? 0,
            ...(limitPrice !== undefined ? { limitPrice } : {}),
            ...(stopPrice !== undefined ? { stopPrice } : {}),
            tif,
            ...(clientOrderId !== undefined ? { clientOrderId } : {}),
            source,
            ...reasonPart,
          });
          reply({ ...result });
          return;
        }
        case "place_oco": {
          const action = fEnum(msg, "action", ORDER_ACTIONS);
          const tif = fEnum(msg, "tif", ORDER_TIFS);
          if (!action || !tif) {
            reply({
              ok: false,
              error: `place_oco needs action ∈ ${ORDER_ACTIONS.join("|")} and tif ∈ ${ORDER_TIFS.join("|")}`,
              certainlyNotSubmitted: true,
            });
            return;
          }
          const result = await exec.submitOco({
            account,
            symbol,
            action,
            quantity: fNum(msg, "quantity") ?? 0,
            stopPrice: fNum(msg, "stopPrice") ?? 0,
            limitPrice: fNum(msg, "limitPrice") ?? 0,
            tif,
            ...(clientOrderId !== undefined ? { clientOrderId } : {}),
            source,
            ...reasonPart,
          });
          reply({ ...result });
          return;
        }
        case "cancel_order": {
          const result = await exec.cancel({
            account,
            clientOrderId: clientOrderId ?? "",
            source,
            ...reasonPart,
          });
          reply({ ...result });
          return;
        }
        case "cancel_all": {
          const result = await exec.cancelAll({ account, symbol, source, ...reasonPart });
          reply({ ...result });
          return;
        }
        case "flatten": {
          const result = await exec.flatten({ account, symbol, source, ...reasonPart });
          reply({ ...result });
          return;
        }
        case "change_order": {
          const quantity = fNum(msg, "quantity");
          const limitPrice = fNum(msg, "limitPrice");
          const stopPrice = fNum(msg, "stopPrice");
          const result = await exec.change({
            account,
            clientOrderId: clientOrderId ?? "",
            ...(quantity !== undefined ? { quantity } : {}),
            ...(limitPrice !== undefined ? { limitPrice } : {}),
            ...(stopPrice !== undefined ? { stopPrice } : {}),
            source,
            ...reasonPart,
          });
          reply({ ...result });
          return;
        }
        default:
          reply({ ok: false, error: `unhandled write op ${op}` });
      }
    } catch (err) {
      // Gateway returns failures as values; a throw here is unexpected — surface it.
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private send(conn: ConsumerConn, obj: Record<string, unknown>): void {
    try {
      conn.ws.send(JSON.stringify(obj));
    } catch (err) {
      console.error(`[feed] ${conn.id} send failed:`, err);
    }
  }
}

// Module singleton: the server routes /feed upgrades here; runtime binds at startup.
export const consumerHub = new ConsumerHub();
