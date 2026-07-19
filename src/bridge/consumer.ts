import type { WebSocket } from "ws";
import { RAW_TIMEFRAMES } from "../core/constants.js";
import type { EnsureResult, LiveSubState, LiveTimeframe } from "../live/registry.js";
import type { Bus, LiveBarEvent, LiveFeedBus } from "../live/bus.js";
import type { PositionBroadcast } from "../live/positions.js";
import { SERVER_VERSION } from "./server.js";

// Consumers whose socket buffer exceeds this are dropped (stuck-bot guard).
const MAX_BUFFERED_BYTES = 4_000_000;

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
}

interface ConsumerConn {
  id: string;
  ws: WebSocket;
  keys: Set<string>;
  // Opted into position broadcasts (position_event/position_sync/trade_closed).
  positions: boolean;
}

/**
 * The /feed side of the bridge server: local consumers (bots, dashboards)
 * subscribe to live bars over WS with the same bearer token as the addon.
 * A consumer subscribe also creates the upstream NT8 subscription, so a bot
 * is self-sufficient. Constructed unbound; the live runtime binds registry +
 * bus at startup — before that, subscribes answer with an error.
 */
export class ConsumerHub {
  private binding: ConsumerHubBinding | null = null;
  private busUnsubscribe: (() => void) | null = null;
  private positionBusUnsubscribe: (() => void) | null = null;
  private positionFeedStatus: (() => { desired: boolean; upstreamAcked: boolean }) | null =
    null;
  private readonly consumers = new Map<string, ConsumerConn>();
  private nextId = 1;

  bind(binding: ConsumerHubBinding, bus: LiveFeedBus): void {
    this.binding = binding;
    if (this.busUnsubscribe) this.busUnsubscribe();
    this.busUnsubscribe = bus.subscribe((e) => this.broadcast(e));
  }

  /** Position broadcasts are receive-only: the upstream toggle is operator-
   *  owned, so opted-in bots get events only while the feed is on. */
  bindPositions(
    bus: Bus<PositionBroadcast>,
    status: () => { desired: boolean; upstreamAcked: boolean },
  ): void {
    this.positionFeedStatus = status;
    if (this.positionBusUnsubscribe) this.positionBusUnsubscribe();
    this.positionBusUnsubscribe = bus.subscribe((b) => this.broadcastPosition(b));
  }

  attach(ws: WebSocket): void {
    const id = `consumer:${this.nextId++}`;
    const conn: ConsumerConn = { id, ws, keys: new Set(), positions: false };
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

    switch (msg.type) {
      case "ping":
        this.send(conn, { type: "pong" });
        return;
      case "subscribe_positions": {
        conn.positions = true;
        const feed = this.positionFeedStatus
          ? this.positionFeedStatus()
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
          !RAW_TIMEFRAMES.includes(timeframe as LiveTimeframe)
        ) {
          this.send(conn, {
            type: "error",
            message: `${msg.type}: timeframe must be one of ${RAW_TIMEFRAMES.join(", ")}`,
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
