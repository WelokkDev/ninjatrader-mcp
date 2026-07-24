import { randomUUID } from "crypto";
import type { WebSocket } from "ws";
import { encode, parseMessage, type OutboundMessage, type InboundMessage } from "./protocol.js";

export const HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Rejected-request classifier; `wasSent` distinguishes provably-not-sent
 * (not-connected, send-failed) from ambiguous (timeout, disconnected,
 * remote-error). `code` carries the C# classifier on remote-error.
 */
export type BridgeErrorKind =
  | "not-connected"
  | "send-failed"
  | "timeout"
  | "disconnected"
  | "remote-error";

export class BridgeRequestError extends Error {
  readonly kind: BridgeErrorKind;
  /** Whether the request provably reached the wire. */
  readonly wasSent: boolean;
  readonly code?: string;

  constructor(message: string, kind: BridgeErrorKind, wasSent: boolean, code?: string) {
    super(message);
    this.name = "BridgeRequestError";
    this.kind = kind;
    this.wasSent = wasSent;
    if (code !== undefined) this.code = code;
  }
}

export interface ConnectionStatus {
  connected: boolean;
  connectedSince: number | null;
  lastHeartbeatAt: number | null;
  ntVersion: string | null;
  instruments: string[];
  /** Write ops the AddOn supports (hello `caps`). null = disconnected OR
   *  an older AddOn that predates caps. */
  caps: string[] | null;
  pendingRequests: number;
}

export type MessageHandler = (message: InboundMessage) => void;

interface PendingRequest {
  resolve: (value: InboundMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  type: string;
}

interface ActiveConnection {
  socket: WebSocket;
  connectedSince: number;
  lastHeartbeatAt: number;
  ntVersion: string | null;
  instruments: string[];
  caps: string[] | null;
  watchdog: NodeJS.Timeout;
}

export class ConnectionManager {
  private active: ActiveConnection | null = null;
  private handlers = new Map<InboundMessage["type"], Set<MessageHandler>>();
  private pending = new Map<string, PendingRequest>();

  hasActiveConnection(): boolean {
    return this.active !== null;
  }

  isConnected(): boolean {
    return this.active !== null;
  }

  getStatus(): ConnectionStatus {
    if (!this.active) {
      return {
        connected: false,
        connectedSince: null,
        lastHeartbeatAt: null,
        ntVersion: null,
        instruments: [],
        caps: null,
        pendingRequests: this.pending.size,
      };
    }
    return {
      connected: true,
      connectedSince: this.active.connectedSince,
      lastHeartbeatAt: this.active.lastHeartbeatAt,
      ntVersion: this.active.ntVersion,
      instruments: [...this.active.instruments],
      caps: this.active.caps ? [...this.active.caps] : null,
      pendingRequests: this.pending.size,
    };
  }

  /** null = disconnected OR AddOn predates caps (treat as place_order-only). */
  getCaps(): string[] | null {
    return this.active?.caps ? [...this.active.caps] : null;
  }

  onMessage<T extends InboundMessage["type"]>(
    type: T,
    handler: (message: Extract<InboundMessage, { type: T }>) => void,
  ): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as MessageHandler);
  }

  send(message: OutboundMessage): boolean {
    if (!this.active) return false;
    try {
      this.active.socket.send(encode(message));
      return true;
    } catch (err) {
      console.error("[bridge] send failed:", err);
      return false;
    }
  }

  request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<InboundMessage> {
    if (!this.active) {
      throw new BridgeRequestError("bridge not connected", "not-connected", false);
    }

    const id = randomUUID();
    const envelope = { v: 1, id, type, ...payload } as unknown as OutboundMessage;

    return new Promise<InboundMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          // Keep message neutral: order callers must not imply mid-submit state.
          reject(
            new BridgeRequestError(
              `Request ${type} (${id}) timed out after ${timeoutMs}ms`,
              "timeout",
              true,
            ),
          );
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, type });

      let sent = false;
      try {
        this.active!.socket.send(encode(envelope));
        sent = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(
            new BridgeRequestError(
              `failed to send request ${type} (${id}): ${msg}`,
              "send-failed",
              false,
            ),
          );
        }
      }

      if (!sent) return;
    });
  }

  attach(socket: WebSocket): void {
    const now = Date.now();
    const conn: ActiveConnection = {
      socket,
      connectedSince: now,
      lastHeartbeatAt: now,
      ntVersion: null,
      instruments: [],
      caps: null,
      watchdog: this.startWatchdog(),
    };
    this.active = conn;

    socket.on("message", (data) => this.handleMessage(conn, data.toString()));
    socket.on("close", (code, reason) => this.handleClose(conn, code, reason.toString()));
    socket.on("error", (err) => console.error("[bridge] socket error:", err.message));

    console.error("[bridge] client connected");
  }

  closeActive(code = 1000, reason = "server shutdown"): void {
    if (!this.active) return;
    try {
      this.active.socket.close(code, reason);
    } catch {
      // ignore
    }
  }

  private rejectAllPending(reason: string): void {
    if (this.pending.size === 0) return;
    // Already on the wire when the socket dropped — outcome unknown (wasSent=true).
    const err = new BridgeRequestError(reason, "disconnected", true);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(conn: ActiveConnection, raw: string): void {
    if (this.active !== conn) return;
    const result = parseMessage(raw);
    if (!result.ok) {
      console.error(`[bridge] dropped message: ${result.reason}`);
      return;
    }
    const msg = result.message as InboundMessage;

    switch (msg.type) {
      case "hello":
        conn.ntVersion = msg.ntVersion;
        conn.instruments = [...msg.instruments];
        conn.caps = msg.caps ? [...msg.caps] : null;
        conn.lastHeartbeatAt = Date.now();
        console.error(
          `[bridge] hello received: NT ${msg.ntVersion}, instruments=[${msg.instruments.join(", ")}]` +
            (msg.caps ? `, caps=[${msg.caps.join(", ")}]` : ", caps=<none> (pre-phase-2 AddOn)"),
        );
        break;
      case "heartbeat":
        conn.lastHeartbeatAt = Date.now();
        break;
      case "instruments_update":
        conn.instruments = [...msg.instruments];
        break;
    }

    // Correlate an inbound id with a pending request.
    const maybeId = (msg as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      const entry = this.pending.get(maybeId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(maybeId);
        if (msg.type === "error") {
          // NT8 processed and refused it; `code` lets the write path tell a
          // pre-Submit block from an ambiguous one.
          entry.reject(new BridgeRequestError(msg.message, "remote-error", true, msg.code));
        } else {
          entry.resolve(msg);
        }
      }
    }

    const set = this.handlers.get(msg.type);
    if (set) {
      for (const h of set) {
        try {
          h(msg);
        } catch (err) {
          console.error("[bridge] handler error:", err);
        }
      }
    }
  }

  private handleClose(conn: ActiveConnection, code: number, reason: string): void {
    if (this.active !== conn) return;
    clearInterval(conn.watchdog);
    this.active = null;
    this.rejectAllPending("NinjaTrader disconnected while waiting for response");
    console.error(`[bridge] client disconnected (code=${code}${reason ? `, reason=${reason}` : ""})`);
  }

  private startWatchdog(): NodeJS.Timeout {
    return setInterval(() => {
      if (!this.active) return;
      const elapsed = Date.now() - this.active.lastHeartbeatAt;
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        console.error(`[bridge] heartbeat timeout (${elapsed}ms) — closing socket`);
        this.closeActive(1011, "heartbeat timeout");
      }
    }, 5_000);
  }
}
