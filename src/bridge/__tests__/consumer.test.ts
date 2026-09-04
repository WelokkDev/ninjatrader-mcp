import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { ConnectionManager } from "../connection.js";
import { startServer, type BridgeServer } from "../server.js";
import {
  consumerHub,
  type ConsumerHubBinding,
  type ExecutionBinding,
  type PositionsBinding,
} from "../consumer.js";
import { Bus, LiveFeedBus } from "../../live/bus.js";
import type { LiveSubState } from "../../live/registry.js";
import type { PositionBroadcast } from "../../live/positions.js";

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
    ensureBars: vi.fn(async () => ({
      ok: true,
      daysChecked: 3,
      windowsFetched: 2,
      windowsFailed: 0,
      bridgeDisconnected: false,
      simFeedRejected: false,
      errors: [],
    })),
    resolveInstrument: vi.fn(async () => ({
      contract: "MNQ 09-26",
      source: "rollover-table",
      attested: true,
      tradable: true,
    })),
    ...over,
  };
}

function stubExecution(): ExecutionBinding {
  return {
    submit: vi.fn(async () => ({
      ok: true as const,
      clientOrderId: "cid-1",
      contract: "MNQ 09-26",
      orderId: "42",
      state: "Submitted",
      deduped: false,
    })),
    submitOco: vi.fn(async () => ({
      ok: true as const,
      ocoId: "base",
      clientOrderId: "base",
      contract: "MNQ 09-26",
      stop: { clientOrderId: "base:S", orderId: "43", state: "Accepted" },
      target: { clientOrderId: "base:T", orderId: "44", state: "Working" },
      deduped: false,
    })),
    cancel: vi.fn(async () => ({
      ok: true as const,
      clientOrderId: "cid-1",
      orderId: "42",
      state: "CancelSubmitted",
    })),
    cancelAll: vi.fn(async () => ({ ok: true as const, contract: "MNQ 09-26" })),
    flatten: vi.fn(async () => ({ ok: true as const, contract: "MNQ 09-26" })),
    change: vi.fn(async () => ({
      ok: true as const,
      clientOrderId: "cid-1",
      orderId: "42",
      state: "ChangeSubmitted",
    })),
  };
}

async function boot(binding?: ConsumerHubBinding | null, execution?: ExecutionBinding | null) {
  const bus = new LiveFeedBus();
  if (binding !== null) {
    consumerHub.bind(binding ?? stubBinding(), bus);
  }
  consumerHub.bindExecution(execution === undefined ? stubExecution() : execution);
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

  it("ensure_bars delegates to the binding and echoes the reqId", async () => {
    const binding = stubBinding();
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(
      JSON.stringify({
        type: "ensure_bars",
        reqId: "warmup-1",
        symbol: "MNQ",
        timeframe: "5m",
        fromUnix: 1_785_100_000,
        toUnix: 1_785_400_000,
      }),
    );
    const reply = await client.next();
    expect(reply.type).toBe("ensure_bars_result");
    expect(reply.reqId).toBe("warmup-1");
    expect(reply.ok).toBe(true);
    expect(reply.windowsFetched).toBe(2);
    expect(binding.ensureBars).toHaveBeenCalledWith("MNQ", "5m", 1_785_100_000, 1_785_400_000);
    client.ws.close();
  });

  it("ensure_bars rejects a derived timeframe and an oversized range as typed failures", async () => {
    const binding = stubBinding();
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(
      JSON.stringify({
        type: "ensure_bars",
        reqId: "bad-tf",
        symbol: "MNQ",
        timeframe: "1h",
        fromUnix: 1,
        toUnix: 2,
      }),
    );
    let reply = await client.next();
    expect(reply.type).toBe("ensure_bars_result");
    expect(reply.reqId).toBe("bad-tf");
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/timeframe/);

    client.ws.send(
      JSON.stringify({
        type: "ensure_bars",
        reqId: "too-big",
        symbol: "MNQ",
        timeframe: "5m",
        fromUnix: 0,
        toUnix: 46 * 86_400,
      }),
    );
    reply = await client.next();
    expect(reply.reqId).toBe("too-big");
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/range exceeds/);
    expect(binding.ensureBars).not.toHaveBeenCalled();
    client.ws.close();
  });

  it("a second ensure_bars while one is in flight is refused, then allowed after it settles", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const binding = stubBinding({
      ensureBars: vi.fn(async () => {
        await gate;
        return {
          ok: true,
          daysChecked: 1,
          windowsFetched: 1,
          windowsFailed: 0,
          bridgeDisconnected: false,
          simFeedRejected: false,
          errors: [],
        };
      }),
    });
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next();
    const req = (reqId: string) =>
      client.ws.send(
        JSON.stringify({
          type: "ensure_bars",
          reqId,
          symbol: "MNQ",
          timeframe: "5m",
          fromUnix: 1,
          toUnix: 1000,
        }),
      );
    req("first");
    req("second");
    const busy = await client.next(); // the overlap refusal answers first
    expect(busy.reqId).toBe("second");
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/in flight/);
    release!();
    const done = await client.next();
    expect(done.reqId).toBe("first");
    expect(done.ok).toBe(true);
    req("third");
    const third = await client.next();
    expect(third.reqId).toBe("third");
    expect(third.ok).toBe(true);
    client.ws.close();
  });

  function stubPositions(over: Partial<PositionsBinding> = {}): PositionsBinding {
    return {
      status: () => ({ desired: true, upstreamAcked: true, lastSyncAt: 1_785_100_500 }),
      snapshot: () => [
        {
          name: "Sim101",
          connection: "Sim",
          connectionStatus: "Connected",
          positions: [
            {
              instrument: "MNQ 09-26",
              symbol: "MNQ",
              marketPosition: "Long",
              quantity: 1,
              updatedAt: 1_785_100_400,
            },
          ],
          orders: [
            {
              orderId: "9",
              name: "zd6bc68a-sxxxxx-1:S",
              instrument: "MNQ 09-26",
              symbol: "MNQ",
              action: "Sell",
              orderType: "StopMarket",
              state: "Working",
              quantity: 1,
              filled: 0,
              updatedAt: 1_785_100_400,
            },
          ],
        },
        { name: "Sim102", connection: "Sim", connectionStatus: "Connected", positions: [], orders: [] },
      ],
      pull: vi.fn(async () => ({ ok: true })),
      ...over,
    };
  }

  it("resolve_instrument answers the arming preflight with provenance", async () => {
    const binding = stubBinding();
    const { port } = await boot(binding);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "resolve_instrument", reqId: "r-9", symbol: "MNQ" }));
    const reply = await client.next();
    expect(reply.type).toBe("resolve_instrument_result");
    expect(reply.reqId).toBe("r-9");
    expect(reply.ok).toBe(true);
    expect(reply).toMatchObject({
      symbol: "MNQ",
      contract: "MNQ 09-26",
      source: "rollover-table",
      attested: true,
      tradable: true,
    });
    expect(binding.resolveInstrument).toHaveBeenCalledWith("MNQ");
    client.ws.close();
  });

  it("resolve_instrument without a symbol is a typed failure", async () => {
    const { port } = await boot(stubBinding());
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "resolve_instrument", reqId: "r-10" }));
    const reply = await client.next();
    expect(reply.type).toBe("resolve_instrument_result");
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/missing symbol/);
    client.ws.close();
  });

  it("sync_positions without a bound feed is a typed failure", async () => {
    const { port } = await boot();
    consumerHub.bindPositions(new Bus<PositionBroadcast>(), null);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "sync_positions", reqId: "r-0" }));
    const reply = await client.next();
    expect(reply.type).toBe("sync_positions_result");
    expect(reply.reqId).toBe("r-0");
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/not bound/);
    client.ws.close();
  });

  it("sync_positions serves the snapshot with trust context and an account filter", async () => {
    const positions = stubPositions();
    const { port } = await boot();
    consumerHub.bindPositions(new Bus<PositionBroadcast>(), positions);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(
      JSON.stringify({ type: "sync_positions", reqId: "r-1", account: "Sim101" }),
    );
    const reply = await client.next();
    expect(reply.type).toBe("sync_positions_result");
    expect(reply.reqId).toBe("r-1");
    expect(reply.ok).toBe(true);
    expect(reply.feedDesired).toBe(true);
    expect(reply.feedUpstreamAcked).toBe(true);
    expect(reply.lastSyncAtUnix).toBe(1_785_100_500);
    expect(reply.pulled).toBe(false); // cached serve — no fresh flag given
    const accounts = reply.accounts as Array<Record<string, unknown>>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe("Sim101");
    expect((accounts[0].positions as unknown[]).length).toBe(1);
    expect((accounts[0].orders as unknown[]).length).toBe(1);
    expect(positions.pull).not.toHaveBeenCalled();
    client.ws.close();
  });

  it("sync_positions fresh pulls NT8 first and reports a pull failure without hiding the mirror", async () => {
    const positions = stubPositions({
      pull: vi.fn(async () => ({ ok: false, error: "NinjaTrader bridge not connected" })),
    });
    const { port } = await boot();
    consumerHub.bindPositions(new Bus<PositionBroadcast>(), positions);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "sync_positions", reqId: "r-2", fresh: true }));
    const reply = await client.next();
    expect(reply.ok).toBe(true);
    expect(reply.pulled).toBe(false);
    expect(reply.pullError).toMatch(/bridge not connected/);
    expect((reply.accounts as unknown[]).length).toBe(2); // no filter → both accounts
    expect(positions.pull).toHaveBeenCalledTimes(1);
    client.ws.close();
  });

  it("a second sync_positions while a fresh pull is in flight is refused", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const positions = stubPositions({
      pull: vi.fn(async () => {
        await gate;
        return { ok: true };
      }),
    });
    const { port } = await boot();
    consumerHub.bindPositions(new Bus<PositionBroadcast>(), positions);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(JSON.stringify({ type: "sync_positions", reqId: "s-1", fresh: true }));
    client.ws.send(JSON.stringify({ type: "sync_positions", reqId: "s-2" }));
    const busy = await client.next();
    expect(busy.reqId).toBe("s-2");
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/in flight/);
    release!();
    const done = await client.next();
    expect(done.reqId).toBe("s-1");
    expect(done.ok).toBe(true);
    expect(done.pulled).toBe(true);
    client.ws.close();
  });

  it("place_order delegates with a server-derived feed source and echoes the result", async () => {
    const execution = stubExecution();
    const { port } = await boot(undefined, execution);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(
      JSON.stringify({
        type: "place_order",
        reqId: "ord-1",
        account: "Sim101",
        symbol: "MNQ",
        action: "Buy",
        orderType: "Market",
        quantity: 1,
        tif: "Day",
        clientOrderId: "zd-1E",
        reason: "zone_dip entry",
      }),
    );
    const reply = await client.next();
    expect(reply.type).toBe("place_order_result");
    expect(reply.reqId).toBe("ord-1");
    expect(reply.ok).toBe(true);
    expect(reply.state).toBe("Submitted");
    expect(execution.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "Sim101",
        symbol: "MNQ",
        action: "Buy",
        quantity: 1,
        clientOrderId: "zd-1E",
        reason: "zone_dip entry",
        source: expect.stringMatching(/^feed:consumer:\d+$/),
      }),
    );
    client.ws.close();
  });

  it("place_order with a bad enum fails typed without touching the gateway", async () => {
    const execution = stubExecution();
    const { port } = await boot(undefined, execution);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(
      JSON.stringify({
        type: "place_order",
        reqId: "bad",
        account: "Sim101",
        symbol: "MNQ",
        action: "YOLO",
        orderType: "Market",
        quantity: 1,
        tif: "Day",
      }),
    );
    const reply = await client.next();
    expect(reply.type).toBe("place_order_result");
    expect(reply.ok).toBe(false);
    expect(reply.certainlyNotSubmitted).toBe(true);
    expect(execution.submit).not.toHaveBeenCalled();
    client.ws.close();
  });

  it("place_oco and flatten delegate and answer with their result types", async () => {
    const execution = stubExecution();
    const { port } = await boot(undefined, execution);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(
      JSON.stringify({
        type: "place_oco",
        reqId: "oco-1",
        account: "Sim101",
        symbol: "MNQ",
        action: "Sell",
        quantity: 1,
        stopPrice: 100,
        limitPrice: 200,
        tif: "Gtc",
        clientOrderId: "zd-1",
      }),
    );
    const oco = await client.next();
    expect(oco.type).toBe("place_oco_result");
    expect((oco.stop as { clientOrderId: string }).clientOrderId).toBe("base:S");

    client.ws.send(
      JSON.stringify({ type: "flatten", reqId: "f1", account: "Sim101", symbol: "MNQ" }),
    );
    const flat = await client.next();
    expect(flat.type).toBe("flatten_result");
    expect(flat.ok).toBe(true);
    expect(execution.flatten).toHaveBeenCalledWith(
      expect.objectContaining({ account: "Sim101", symbol: "MNQ" }),
    );
    client.ws.close();
  });

  it("write ops without a wired gateway fail closed", async () => {
    const { port } = await boot(undefined, null);
    const client = await connect(port, "/feed");
    await client.next();
    client.ws.send(
      JSON.stringify({ type: "flatten", reqId: "f2", account: "Sim101", symbol: "MNQ" }),
    );
    const reply = await client.next();
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/not wired/);
    client.ws.close();
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
