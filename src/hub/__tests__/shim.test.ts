import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { HUB_LOST_CODE, ShimPipe } from "../shim.js";

class MemTransport implements Transport {
  peer: MemTransport | null = null;
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  dead = false;
  hang = false;
  private hung: Array<(e: Error) => void> = [];
  closed = false;
  received: JSONRPCMessage[] = [];
  protocolVersion?: string;
  terminateSession = vi.fn(async () => {});

  async start(): Promise<void> {}
  async send(m: JSONRPCMessage): Promise<void> {
    if (this.dead) throw new Error("ECONNREFUSED");
    if (this.hang) return new Promise((_, reject) => this.hung.push(reject));
    this.peer?.deliver(m);
  }
  deliver(m: JSONRPCMessage): void {
    this.received.push(m);
    this.onmessage?.(m);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const reject of this.hung) reject(new Error("aborted"));
    this.onclose?.();
  }
  setProtocolVersion(v: string): void {
    this.protocolVersion = v;
  }
}

function pair(): [MemTransport, MemTransport] {
  const a = new MemTransport();
  const b = new MemTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

interface HubOpts {
  ignoreCalls?: boolean;
  initDelayMs?: number;
}

function fakeHub(side: MemTransport, generation: number, opts: HubOpts = {}) {
  let initialized = false;
  side.onmessage = (m) => {
    if (!isJSONRPCRequest(m)) return;
    if (m.method === "initialize") {
      setTimeout(() => {
        initialized = true;
        void side.send({
          jsonrpc: "2.0",
          id: m.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } },
        });
      }, opts.initDelayMs ?? 0);
    } else if (m.method === "ping") {
      void side.send({ jsonrpc: "2.0", id: m.id, result: {} });
    } else if (m.method === "tools/call" && !opts.ignoreCalls) {
      // Like the real hub's 400 before the session exists.
      void side.send(
        initialized
          ? { jsonrpc: "2.0", id: m.id, result: { generation } }
          : { jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "not initialized" } },
      );
    }
  };
}

interface Harness {
  client: MemTransport;
  pipe: ShimPipe;
  hubs: MemTransport[];
  remotes: MemTransport[];
  connect: ReturnType<typeof vi.fn>;
  onStopped: ReturnType<typeof vi.fn>;
}

function harness(hubOpts: HubOpts = {}, failConnect = false): Harness {
  const [client, local] = pair();
  const hubs: MemTransport[] = [];
  const remotes: MemTransport[] = [];
  const connect = vi.fn(async () => {
    if (failConnect) throw new Error("spawn failed");
    const [remote, hub] = pair();
    hubs.push(hub);
    remotes.push(remote);
    fakeHub(hub, hubs.length, hubOpts);
    return remote;
  });
  const onStopped = vi.fn();
  const pipe = new ShimPipe({
    local,
    connect,
    onStopped,
    log: () => {},
    handshakeTimeoutMs: 200,
    heartbeatMs: 20,
  });
  return { client, pipe, hubs, remotes, connect, onStopped };
}

const initialize = (id: number): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cc", version: "1" } },
});
const initialized: JSONRPCMessage = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = (id: number): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "x", arguments: {} },
});

async function handshake(h: Harness): Promise<void> {
  await h.pipe.start();
  await h.client.send(initialize(1));
  await vi.waitFor(() => expect(h.client.received.some((m) => "id" in m && m.id === 1)).toBe(true));
  await h.client.send(initialized);
}

const responses = (t: MemTransport) => t.received.filter((m) => "id" in m && !("method" in m));
const answersTo = (t: MemTransport, id: number) =>
  responses(t).filter((m) => (m as { id: unknown }).id === id).length;
const requested = (t: MemTransport, pred: (m: JSONRPCRequest) => boolean) =>
  t.received.filter((m) => isJSONRPCRequest(m) && pred(m)).length;
const byId = (t: MemTransport, id: number) =>
  responses(t).find((m) => (m as { id: unknown }).id === id) as
    | { result?: unknown; error?: { code: number; message: string } }
    | undefined;

describe("ShimPipe", () => {
  it("pipes the handshake and requests both ways, learning the protocol version", async () => {
    const h = harness();
    await handshake(h);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.hubs[0].received.filter(isJSONRPCNotification).map((m) => m.method)).toEqual([
      "notifications/initialized",
    ]);
    expect(h.remotes[0].protocolVersion).toBe("2025-06-18");

    await h.client.send(call(2));
    await vi.waitFor(() => expect(byId(h.client, 2)?.result).toEqual({ generation: 1 }));
  });

  it("survives a hub restart: replays the handshake, retries the request, announces the tool list", async () => {
    const h = harness();
    await handshake(h);
    h.remotes[0].dead = true;

    await h.client.send(call(3));
    await vi.waitFor(() => expect(byId(h.client, 3)?.result).toEqual({ generation: 2 }));
    expect(h.connect).toHaveBeenCalledTimes(2);

    const replayed = h.hubs[1].received.filter(isJSONRPCRequest).find((m) => m.method === "initialize");
    expect(replayed).toBeDefined();
    expect(String(replayed!.id)).toMatch(/^shim-init-/);
    expect(replayed!.params).toMatchObject({ clientInfo: { name: "cc" } });
    expect(h.hubs[1].received.filter(isJSONRPCNotification).map((m) => m.method)).toEqual([
      "notifications/initialized",
    ]);
    expect(h.client.received.filter(isJSONRPCNotification).map((m) => m.method)).toEqual([
      "notifications/tools/list_changed",
    ]);
    expect(responses(h.client).map((m) => (m as { id: unknown }).id)).toEqual([1, 3]);
    expect(byId(h.client, 3)?.error).toBeUndefined();
  });

  it("fails in-flight requests when the hub dies, though the transport never reports it", async () => {
    const h = harness({ ignoreCalls: true });
    await handshake(h);
    await h.client.send(call(5));
    await vi.waitFor(() => expect(requested(h.hubs[0], (m) => m.method === "ping")).toBeGreaterThan(1));
    expect(responses(h.client).map((m) => (m as { id: unknown }).id)).toEqual([1]);

    h.remotes[0].dead = true;
    await vi.waitFor(() => expect(byId(h.client, 5)?.error?.code).toBe(HUB_LOST_CODE));
  });

  it("stops watching a request the client cancelled", async () => {
    const h = harness({ ignoreCalls: true });
    await handshake(h);
    await h.client.send(call(6));
    await h.client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 6 } });
    const pings = requested(h.hubs[0], (m) => m.method === "ping");
    await new Promise((r) => setTimeout(r, 80));
    expect(requested(h.hubs[0], (m) => m.method === "ping")).toBe(pings);
  });

  it("holds a message sent during the replayed handshake until the new session is up", async () => {
    const h = harness({ initDelayMs: 60 });
    await handshake(h);
    h.remotes[0].dead = true;
    await h.client.send(call(3));
    await vi.waitFor(() => expect(h.hubs[1]?.received.length).toBeGreaterThan(0), { interval: 2 });
    await h.client.send(call(4));

    await vi.waitFor(() => expect(byId(h.client, 4)?.result).toEqual({ generation: 2 }));
    expect(byId(h.client, 3)?.result).toEqual({ generation: 2 });
  });

  it("never retries a request that another failure already answered", async () => {
    const h = harness();
    await handshake(h);
    h.remotes[0].hang = true;
    await h.client.send(call(3));
    h.remotes[0].dead = true;
    await h.client.send(call(4));

    await vi.waitFor(() => expect(byId(h.client, 4)?.result).toEqual({ generation: 2 }));
    expect(byId(h.client, 3)?.error?.code).toBe(HUB_LOST_CODE);
    expect(answersTo(h.client, 3)).toBe(1);
    expect(requested(h.hubs[1], (m) => m.id === 3)).toBe(0);
  });

  it("answers the client with an error when the hub cannot be reached at all", async () => {
    const h = harness({}, true);
    await h.pipe.start();
    await h.client.send(initialize(1));
    await vi.waitFor(() => expect(byId(h.client, 1)?.error?.message).toMatch(/hub unreachable/));
  });

  it("terminates the hub session when the client goes away", async () => {
    const h = harness();
    await handshake(h);
    await h.client.peer!.close();
    await vi.waitFor(() => expect(h.onStopped).toHaveBeenCalledWith("client closed"));
    expect(h.remotes[0].terminateSession).toHaveBeenCalledTimes(1);
  });
});
