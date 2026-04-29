import type { WebSocket } from "ws";
import { encode, parseMessage, type OutboundMessage, type InboundMessage } from "./protocol.js";

export const HEARTBEAT_TIMEOUT_MS = 30_000;

export interface ConnectionStatus {
  connected: boolean;
  connectedSince: number | null;
  lastHeartbeatAt: number | null;
  ntVersion: string | null;
  instruments: string[];
}

export type MessageHandler = (message: InboundMessage) => void;

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

  hasActiveConnection(): boolean {
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
      };
    }
    return {
      connected: true,
      connectedSince: this.active.connectedSince,
      lastHeartbeatAt: this.active.lastHeartbeatAt,
      ntVersion: this.active.ntVersion,
      instruments: [...this.active.instruments],
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
