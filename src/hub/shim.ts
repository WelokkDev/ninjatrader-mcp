import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCError,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCResultResponse,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

export interface ShimPipeOptions {
  local: Transport;
  connect: () => Promise<Transport>;
  onStopped?: (reason: string) => void;
  log?: (line: string) => void;
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
export const HUB_LOST_CODE = -32000;

export class ShimPipe {
  private readonly local: Transport;
  private readonly connect: () => Promise<Transport>;
  private readonly log: (line: string) => void;
  private readonly handshakeTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly onStopped?: (reason: string) => void;

  private remote: Transport | null = null;
  private connecting: Promise<Transport> | null = null;
  // May legitimately be undefined; handshakeDone says whether there is one to replay.
  private initParams: JSONRPCRequest["params"] = undefined;
  private initId: RequestId | null = null;
  private handshakeDone = false;
  private readonly pending = new Set<RequestId>();
  private readonly waiters = new Map<
    string,
    { resolve: (m: JSONRPCResultResponse | JSONRPCErrorResponse) => void; reject: (e: Error) => void }
  >();
  private seq = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private pinging = false;
  private stopped = false;

  constructor(opts: ShimPipeOptions) {
    this.local = opts.local;
    this.connect = opts.connect;
    this.log = opts.log ?? ((line) => console.error(line));
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onStopped = opts.onStopped;
  }

  async start(): Promise<void> {
    this.local.onmessage = (m) => void this.fromLocal(m);
    this.local.onclose = () => void this.stop("client closed");
    this.local.onerror = (e) => this.log(`[shim] client transport error: ${e.message}`);
    await this.local.start();
    this.heartbeat = setInterval(() => void this.checkHub(), this.heartbeatMs);
    this.heartbeat.unref();
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const t = this.remote;
    this.remote = null;
    if (t) {
      // Tell the hub the session is over now rather than after its detach grace.
      const terminate = (t as { terminateSession?: () => Promise<void> }).terminateSession;
      if (terminate) await terminate.call(t).catch(() => undefined);
      await t.close().catch(() => undefined);
    }
    this.onStopped?.(reason);
  }

  private async fromLocal(msg: JSONRPCMessage): Promise<void> {
    if (isJSONRPCRequest(msg)) {
      if (msg.method === "initialize") {
        this.initParams = msg.params;
        this.initId = msg.id;
      }
      this.pending.add(msg.id);
    } else if (isJSONRPCNotification(msg) && msg.method === "notifications/initialized") {
      this.handshakeDone = true;
    } else if (isJSONRPCNotification(msg) && msg.method === "notifications/cancelled") {
      // The hub never answers a cancelled request.
      this.pending.delete(msg.params?.requestId as RequestId);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let remote: Transport;
      try {
        remote = await this.ensureRemote();
      } catch (err) {
        this.failLocal(msg, `hub unreachable: ${text(err)}`);
        return;
      }
      try {
        await remote.send(msg);
        return;
      } catch (err) {
        // Another drop already answered it; a retry would run it after the client was told it failed.
        if (isJSONRPCRequest(msg) && !this.pending.has(msg.id)) return;
        this.log(`[shim] send to hub failed (${text(err)}); reconnecting`);
        this.dropRemote(remote, isJSONRPCRequest(msg) ? msg.id : undefined);
      }
    }
    this.failLocal(msg, "hub unreachable after reconnect");
  }

  private fromRemote(msg: JSONRPCMessage): void {
    if ((isJSONRPCResponse(msg) || isJSONRPCError(msg)) && msg.id != null) {
      const waiter = this.waiters.get(String(msg.id));
      if (waiter) {
        this.waiters.delete(String(msg.id));
        waiter.resolve(msg);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.id === this.initId && isJSONRPCResponse(msg)) {
        this.initId = null;
        this.adoptProtocolVersion(this.remote, msg.result);
      }
    }
    void this.local.send(msg).catch((err) => this.log(`[shim] send to client failed: ${text(err)}`));
  }

  private ensureRemote(): Promise<Transport> {
    if (this.remote) return Promise.resolve(this.remote);
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async open(): Promise<Transport> {
    const t = await this.connect();
    t.onmessage = (m) => this.fromRemote(m);
    t.onerror = (e) => this.log(`[shim] hub transport error: ${e.message}`);
    t.onclose = () => this.dropRemote(t);
    if (this.handshakeDone) {
      try {
        await this.replayHandshake(t);
      } catch (err) {
        await t.close().catch(() => undefined);
        throw err;
      }
      this.log("[shim] reattached to the hub under a new session");
      await this.local.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    // Only now: a message sent mid-replay would reach the hub without the session id.
    this.remote = t;
    return t;
  }

  private async replayHandshake(t: Transport): Promise<void> {
    const id = `shim-init-${++this.seq}`;
    const reply = await this.roundTrip(t, {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      ...(this.initParams !== undefined ? { params: this.initParams } : {}),
    } as JSONRPCRequest);
    if (isJSONRPCError(reply)) throw new Error(`hub rejected initialize: ${reply.error.message}`);
    this.adoptProtocolVersion(t, reply.result);
    await t.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private roundTrip(
    t: Transport,
    req: JSONRPCRequest,
  ): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
    const key = String(req.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error("handshake with the hub timed out"));
      }, this.handshakeTimeoutMs);
      this.waiters.set(key, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      t.send(req).catch((err) => {
        clearTimeout(timer);
        this.waiters.delete(key);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private adoptProtocolVersion(t: Transport | null, result: unknown): void {
    const version = (result as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof version === "string") t?.setProtocolVersion?.(version);
  }

  // The HTTP transport never reports a dead hub, so ping while requests are open.
  private async checkHub(): Promise<void> {
    const t = this.remote;
    if (!t || !this.handshakeDone || this.pinging || this.pending.size === 0) return;
    const id = `shim-ping-${++this.seq}`;
    this.waiters.set(id, { resolve: () => {}, reject: () => {} }); // swallows the pong
    this.pinging = true;
    try {
      await t.send({ jsonrpc: "2.0", id, method: "ping" });
    } catch (err) {
      this.waiters.delete(id);
      this.log(`[shim] hub stopped answering (${text(err)}); failing in-flight requests`);
      this.dropRemote(t);
    } finally {
      this.pinging = false;
    }
  }

  private dropRemote(t: Transport, keep?: RequestId): void {
    if (this.remote !== t) return;
    this.remote = null;
    void t.close().catch(() => undefined);
    for (const w of this.waiters.values()) w.reject(new Error("hub connection lost"));
    this.waiters.clear();
    for (const id of [...this.pending]) {
      if (id === keep) continue;
      this.pending.delete(id);
      void this.local.send(
        errorResponse(id, "hub connection lost mid-request (the hub restarted or went away); retry the call"),
      );
    }
  }

  private failLocal(msg: JSONRPCMessage, reason: string): void {
    if (isJSONRPCRequest(msg)) {
      this.pending.delete(msg.id);
      void this.local.send(errorResponse(msg.id, reason));
    } else {
      this.log(`[shim] dropped ${describe(msg)}: ${reason}`);
    }
  }
}

function errorResponse(id: RequestId, message: string): JSONRPCErrorResponse {
  return { jsonrpc: "2.0", id, error: { code: HUB_LOST_CODE, message } };
}

function describe(msg: JSONRPCMessage): string {
  return "method" in msg ? msg.method : "response";
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
