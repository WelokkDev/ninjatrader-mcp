import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { ConnectionManager } from "../connection.js";
import { startServer, type BridgeServer } from "../server.js";
import { consumerHub, type ConsumerHubBinding } from "../consumer.js";
import { LiveFeedBus } from "../../live/bus.js";
import type { LiveSubState } from "../../live/registry.js";

const TOKEN = "test-token";

let server: BridgeServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

function subState(over: Partial<LiveSubState> = {}): LiveSubState {
  return {
    symbol: "NQ",
    timeframe: "5m",
    sources: ["consumer:1"],
    acked: true,
    contract: "NQ 09-26",
    lastSeq: null,
    lastTs: null,
    lastError: null,
    subscribedAt: 1,
    ackedAt: 2,
    ...over,
  };
}

function stubBinding(over: Partial<ConsumerHubBinding> = {}): ConsumerHubBinding {
  return {
    ensure: vi.fn(async () => ({ ok: true, state: subState() })),
    release: vi.fn(async () => ({ removedUpstream: true })),
    releaseAllForSource: vi.fn(async () => {}),
    list: () => [],
    ...over,
  };
}

async function boot(binding?: ConsumerHubBinding | null) {
  const bus = new LiveFeedBus();
  if (binding !== null) {
    consumerHub.bind(binding ?? stubBinding(), bus);
  }
  server = await startServer({
    port: 0,
    token: TOKEN,
    connections: new ConnectionManager(),
  });
  return { bus, port: server.port };
}

function connect(
  port: number,
  path: string,
  token: string | null = TOKEN,
): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>>; next: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else messages.push(parsed);
    });
    const next = (): Promise<Record<string, unknown>> => {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((res) => waiters.push(res));
    };
    ws.on("open", () => resolve({ ws, messages, next }));
    ws.on("error", reject);
  });
}

function expectUpgradeRejection(port: number, path: string, token: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    ws.on("open", () => reject(new Error("upgrade unexpectedly accepted")));
    ws.on("error", (err) => resolve(err.message));
  });
}

describe("/feed channel", () => {
  it("sends a welcome carrying current subscriptions on connect", async () => {
    const binding = stubBinding({ list: () => [subState()] });
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    const welcome = await client.next();
    expect(welcome.type).toBe("welcome");
    expect(welcome.subscriptions).toHaveLength(1);
    client.ws.close();
  });

  it("rejects a bad token with 401", async () => {
    const { port } = await boot();
    const err = await expectUpgradeRejection(port, "/feed", "wrong-token");
    expect(err).toMatch(/401/);
  });

  it("rejects an unknown path with 404", async () => {
    const { port } = await boot();
    const err = await expectUpgradeRejection(port, "/nope", TOKEN);
    expect(err).toMatch(/404/);
  });

  it("subscribe calls ensure with a consumer source and answers with upstream truth", async () => {
    const binding = stubBinding();
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next(); // welcome
    client.ws.send(JSON.stringify({ type: "subscribe", symbol: "NQ", timeframe: "5m" }));
    const reply = await client.next();
    expect(reply.type).toBe("subscribed");
    expect(reply.ok).toBe(true);
    expect((reply.upstream as { contract: string }).contract).toBe("NQ 09-26");
    expect(binding.ensure).toHaveBeenCalledWith("NQ", "5m", expect.stringMatching(/^consumer:\d+$/));
    client.ws.close();
  });

  it("rejects a derived timeframe without calling ensure", async () => {
    const binding = stubBinding();
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "subscribe", symbol: "NQ", timeframe: "1h" }));
    const reply = await client.next();
    expect(reply.type).toBe("error");
    expect(binding.ensure).not.toHaveBeenCalled();
    client.ws.close();
  });

  it("pushes bus bars only to consumers subscribed to that key", async () => {
    const { bus, port } = await boot();
    const subbed = await connect(port, "/feed");
    const other = await connect(port, "/feed");
    await subbed.next();
    await other.next();
    subbed.ws.send(JSON.stringify({ type: "subscribe", symbol: "NQ", timeframe: "5m" }));
    await subbed.next(); // subscribed reply
    other.ws.send(JSON.stringify({ type: "subscribe", symbol: "MNQ", timeframe: "5m" }));
    await other.next();

    bus.publish({
      symbol: "NQ",
      timeframe: "5m",
      candle: { timestamp: 1789000500, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
      seq: 9,
      receivedAtMs: 1789000500123,
    });

    const bar = await subbed.next();
    expect(bar.type).toBe("bar");
    expect(bar.symbol).toBe("NQ");
    expect(bar.seq).toBe(9);
    // The other consumer got nothing beyond its handshake traffic.
    expect(other.messages).toHaveLength(0);
    subbed.ws.close();
    other.ws.close();
  });

  it("multiple consumers on the same key each receive the bar", async () => {
    const { bus, port } = await boot();
    const a = await connect(port, "/feed");
    const b = await connect(port, "/feed");
    await a.next();
    await b.next();
    for (const c of [a, b]) {
      c.ws.send(JSON.stringify({ type: "subscribe", symbol: "NQ", timeframe: "5m" }));
      await c.next();
    }
    bus.publish({
      symbol: "NQ",
      timeframe: "5m",
      candle: { timestamp: 1789000800, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
      receivedAtMs: 1789000800001,
    });
    expect((await a.next()).type).toBe("bar");
    expect((await b.next()).type).toBe("bar");
    a.ws.close();
    b.ws.close();
  });

  it("unsubscribe reply carries the upstream-release truth", async () => {
    const binding = stubBinding({
      release: vi.fn(async () => ({ removedUpstream: false, pendingUpstreamRelease: true })),
    });
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "subscribe", symbol: "NQ", timeframe: "5m" }));
    await client.next();
    client.ws.send(JSON.stringify({ type: "unsubscribe", symbol: "NQ", timeframe: "5m" }));
    const reply = await client.next();
    expect(reply.type).toBe("unsubscribed");
    expect(reply.upstreamReleased).toBe(false);
    expect(reply.pendingUpstreamRelease).toBe(true);
    client.ws.close();
  });

  it("socket close releases every key that consumer held", async () => {
    const binding = stubBinding();
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "subscribe", symbol: "NQ", timeframe: "5m" }));
    await client.next();
    client.ws.close();
    await vi.waitFor(() => {
      expect(binding.releaseAllForSource).toHaveBeenCalledWith(
        expect.stringMatching(/^consumer:\d+$/),
      );
    });
  });

  it("malformed JSON gets an error reply and the connection survives", async () => {
    const { port } = await boot();
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send("{not json");
    const reply = await client.next();
    expect(reply.type).toBe("error");
    client.ws.send(JSON.stringify({ type: "ping" }));
    expect((await client.next()).type).toBe("pong");
    client.ws.close();
  });

  it("addon path '/' still enforces single-connection 409", async () => {
    const { port } = await boot();
    const addon = await connect(port, "/");
    const err = await expectUpgradeRejection(port, "/", TOKEN);
    expect(err).toMatch(/409/);
    addon.ws.close();
  });

  it("consumers do not consume the addon slot: '/' connects fine with feed clients attached", async () => {
    const { port } = await boot();
    const feed = await connect(port, "/feed");
    await feed.next();
    const addon = await connect(port, "/");
    expect(addon.ws.readyState).toBe(WebSocket.OPEN);
    addon.ws.close();
    feed.ws.close();
  });
});
