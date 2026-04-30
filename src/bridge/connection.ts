import { randomUUID } from "crypto";
import type { WebSocket } from "ws";
import { encode, parseMessage, type OutboundMessage, type InboundMessage } from "./protocol.js";

export const HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface ConnectionStatus {
  connected: boolean;
  connectedSince: number | null;
  lastHeartbeatAt: number | null;
  ntVersion: string | null;
  instruments: string[];
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
        pendingRequests: this.pending.size,
      };
    }
    return {
      connected: true,
      connectedSince: this.active.connectedSince,
      lastHeartbeatAt: this.active.lastHeartbeatAt,
      ntVersion: this.active.ntVersion,
      instruments: [...this.active.instruments],
      pendingRequests: this.pending.size,
    };
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
      throw new Error("bridge not connected");
    }

    const id = randomUUID();
    const envelope = { v: 1, id, type, ...payload } as unknown as OutboundMessage;

    return new Promise<InboundMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              `Request ${type} (${id}) timed out after ${timeoutMs}ms — is NinjaTrader running?`,
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
          reject(new Error(`failed to send request ${type} (${id}): ${msg}`));
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
    const err = new Error(reason);
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
        conn.lastHeartbeatAt = Date.now();
        console.error(
          `[bridge] hello received: NT ${msg.ntVersion}, instruments=[${msg.instruments.join(", ")}]`,
        );
        break;
      case "heartbeat":
        conn.lastHeartbeatAt = Date.now();
        break;
    }

    // Correlate any inbound message that carries an id with a pending request.
    const maybeId = (msg as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      const entry = this.pending.get(maybeId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(maybeId);
        if (msg.type === "error") {
          entry.reject(new Error(msg.message));
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
