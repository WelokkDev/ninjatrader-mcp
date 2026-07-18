import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import {
  LiveSubscriptionRegistry,
  MCP_SOURCE,
  type RegistryDeps,
} from "../registry.js";
import type { BarCloseMessage, SubscribeAckMessage } from "../../bridge/protocol.js";

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function ack(over: Partial<SubscribeAckMessage> = {}): SubscribeAckMessage {
  return {
    v: 1,
    id: "x",
    type: "subscribe_ack",
    symbol: "MNQ",
    timeframe: "5m",
    contract: "MNQ 09-26",
    seedCount: 30,
    seedLastTs: 1789000200,
    alreadyActive: false,
    ...over,
  };
}

function barClose(over: Partial<BarCloseMessage> = {}): BarCloseMessage {
  return {
    v: 1,
    type: "bar_close",
    symbol: "MNQ",
    timeframe: "5m",
    candle: {
      timestamp: 1789000500,
      open: 100, high: 101, low: 99, close: 100.5, volume: 10,
    },
    seq: 3,
    contract: "MNQ 09-26",
    ...over,
  };
}

function makeDeps(over: Partial<RegistryDeps> = {}): RegistryDeps {
  return {
    db: memDb(),
    request: vi.fn(async () => ack()),
    isConnected: () => true,
    nowUnix: () => 1789000000,
    ...over,
  };
}

describe("LiveSubscriptionRegistry.ensure", () => {
  it("rejects an unknown symbol without creating state", async () => {
    const reg = new LiveSubscriptionRegistry(makeDeps());
    const res = await reg.ensure("NOPE", "5m", MCP_SOURCE);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(reg.list()).toHaveLength(0);
  });

  it("rejects a non-raw timeframe defensively", async () => {
    const reg = new LiveSubscriptionRegistry(makeDeps());
    const res = await reg.ensure("MNQ", "1h" as never, MCP_SOURCE);
    expect(res.ok).toBe(false);
    expect(reg.list()).toHaveLength(0);
  });

  it("while disconnected: records desired state + persists, returns ok:false", async () => {
    const db = memDb();
    const request = vi.fn(async () => ack());
    const reg = new LiveSubscriptionRegistry(
      makeDeps({ db, request, isConnected: () => false }),
    );
    const res = await reg.ensure("MNQ", "5m", MCP_SOURCE);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected/i);
    expect(request).not.toHaveBeenCalled();
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].acked).toBe(false);
    const rows = db.prepare("SELECT * FROM live_subscriptions").all();
    expect(rows).toHaveLength(1);
  });

  it("while connected: sends subscribe_bars with the session template and records the ack", async () => {
    const request = vi.fn(async () => ack());
    const reg = new LiveSubscriptionRegistry(makeDeps({ request }));
    const res = await reg.ensure("MNQ", "5m", MCP_SOURCE);
    expect(res.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "subscribe_bars",
      expect.objectContaining({
        symbol: "MNQ",
        timeframe: "5m",
        tradingHoursTemplate: "cme_us_index_futures_eth",
      }),
      expect.any(Number),
    );
    const st = reg.list()[0];
    expect(st.acked).toBe(true);
    expect(st.contract).toBe("MNQ 09-26");
    expect(st.ackedAt).toBe(1789000000);
  });

  it("request rejection keeps desired state and surfaces the error", async () => {
    const request = vi.fn(async () => {
      throw new Error("Request subscribe_bars (x) timed out after 15000ms");
    });
    const reg = new LiveSubscriptionRegistry(makeDeps({ request }));
    const res = await reg.ensure("MNQ", "5m", MCP_SOURCE);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/);
    // Recompile hint appended on timeouts (stale AddOn is the common cause).
    expect(res.error).toMatch(/recompile/i);
    const st = reg.list()[0];
    expect(st.acked).toBe(false);
    expect(st.lastError).toMatch(/timed out/);
  });

  it("a SYNCHRONOUSLY throwing request (real disconnected behavior) is contained", async () => {
    const request = vi.fn(() => {
      throw new Error("bridge not connected");
    }) as unknown as RegistryDeps["request"];
    const reg = new LiveSubscriptionRegistry(makeDeps({ request }));
    const res = await reg.ensure("MNQ", "5m", MCP_SOURCE);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected/);
  });

  it("second source on the same key unions sources without duplicate persistence or re-request", async () => {
    const db = memDb();
    const request = vi.fn(async () => ack());
    const reg = new LiveSubscriptionRegistry(makeDeps({ db, request }));
    await reg.ensure("MNQ", "5m", MCP_SOURCE);
    const res2 = await reg.ensure("MNQ", "5m", "consumer:1");
    expect(res2.ok).toBe(true);
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].sources.sort()).toEqual(["consumer:1", MCP_SOURCE].sort());
    // Upstream already acked — no second subscribe_bars round-trip.
    expect(request).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT * FROM live_subscriptions").all()).toHaveLength(1);
  });
});

describe("LiveSubscriptionRegistry.release", () => {
  let db: Database.Database;
  let request: ReturnType<typeof vi.fn>;
  let reg: LiveSubscriptionRegistry;

  beforeEach(async () => {
    db = memDb();
    request = vi.fn(async (type: string) =>
      type === "subscribe_bars"
        ? ack()
        : { v: 1, id: "y", type: "unsubscribe_ack", symbol: "MNQ", timeframe: "5m", removed: true },
    );
    reg = new LiveSubscriptionRegistry(
      makeDeps({ db, request: request as unknown as RegistryDeps["request"] }),
    );
    await reg.ensure("MNQ", "5m", MCP_SOURCE);
    await reg.ensure("MNQ", "5m", "consumer:1");
  });

  it("removing one of two sources keeps the upstream sub", async () => {
    const res = await reg.release("MNQ", "5m", "consumer:1");
    expect(res.removedUpstream).toBe(false);
    expect(reg.list()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM live_subscriptions").all()).toHaveLength(1);
  });

  it("removing the last source unsubscribes upstream, unpersists, drops state", async () => {
    await reg.release("MNQ", "5m", "consumer:1");
    const res = await reg.release("MNQ", "5m", MCP_SOURCE);
    expect(res.removedUpstream).toBe(true);
    expect(reg.list()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM live_subscriptions").all()).toHaveLength(0);
    expect(request).toHaveBeenCalledWith("unsubscribe_bars", expect.objectContaining({ symbol: "MNQ" }), expect.any(Number));
  });

  it("failed upstream unsubscribe is contained AND reported truthfully as pending", async () => {
    await reg.release("MNQ", "5m", "consumer:1");
    const throwing = vi.fn(() => {
      throw new Error("bridge not connected");
    });
    const reg2 = new LiveSubscriptionRegistry(
      makeDeps({ db: memDb(), request: throwing as unknown as RegistryDeps["request"] }),
    );
    await reg2.ensure("MNQ", "5m", MCP_SOURCE).catch(() => {});
    await expect(reg2.release("MNQ", "5m", MCP_SOURCE)).resolves.toEqual({
      removedUpstream: false,
      pendingUpstreamRelease: true,
    });
    expect(reg2.pendingUnsubscribeKeys()).toEqual(["MNQ:5m"]);
  });

  it("last-source release while DISCONNECTED records a pending upstream release", async () => {
    await reg.release("MNQ", "5m", "consumer:1");
    const request = vi.fn(async () => ack());
    const reg2 = new LiveSubscriptionRegistry(
      makeDeps({ db: memDb(), request, isConnected: () => false }),
    );
    await reg2.ensure("MNQ", "5m", MCP_SOURCE).catch(() => {});
    const res = await reg2.release("MNQ", "5m", MCP_SOURCE);
    expect(res.removedUpstream).toBe(false);
    expect(res.pendingUpstreamRelease).toBe(true);
    expect(request).not.toHaveBeenCalledWith("unsubscribe_bars", expect.anything(), expect.anything());
    expect(reg2.pendingUnsubscribeKeys()).toEqual(["MNQ:5m"]);
  });

  it("replayAll flushes pending unsubscribes before replaying", async () => {
    let unsubShouldFail = true;
    const request = vi.fn(async (type: string) => {
      if (type === "unsubscribe_bars") {
        if (unsubShouldFail) throw new Error("boom");
        return { v: 1, id: "y", type: "unsubscribe_ack", symbol: "MNQ", timeframe: "5m", removed: true };
      }
      return ack();
    });
    const reg2 = new LiveSubscriptionRegistry(makeDeps({ db: memDb(), request }));
    await reg2.ensure("MNQ", "5m", MCP_SOURCE);
    await reg2.release("MNQ", "5m", MCP_SOURCE); // fails → pending
    expect(reg2.pendingUnsubscribeKeys()).toEqual(["MNQ:5m"]);
    unsubShouldFail = false;
    await reg2.replayAll();
    expect(reg2.pendingUnsubscribeKeys()).toEqual([]);
    expect(request).toHaveBeenCalledWith(
      "unsubscribe_bars",
      expect.objectContaining({ symbol: "MNQ", timeframe: "5m" }),
      expect.any(Number),
    );
  });

  it("re-ensuring a key cancels its pending upstream release", async () => {
    const request = vi.fn(async (type: string) => {
      if (type === "unsubscribe_bars") throw new Error("boom");
      return ack();
    });
    const reg2 = new LiveSubscriptionRegistry(makeDeps({ db: memDb(), request }));
    await reg2.ensure("MNQ", "5m", MCP_SOURCE);
    await reg2.release("MNQ", "5m", MCP_SOURCE);
    expect(reg2.pendingUnsubscribeKeys()).toEqual(["MNQ:5m"]);
    await reg2.ensure("MNQ", "5m", MCP_SOURCE);
    expect(reg2.pendingUnsubscribeKeys()).toEqual([]);
    // The flush pass must not release the re-created sub on the next hello.
    await reg2.replayAll();
    expect(reg2.list()).toHaveLength(1);
  });

  it("releaseAllForSource releases every key that source held", async () => {
    await reg.ensure("NQ", "15m", "consumer:1");
    await reg.releaseAllForSource("consumer:1");
    const keys = reg.list().map((s) => `${s.symbol}:${s.timeframe}`);
    expect(keys).toEqual(["MNQ:5m"]); // MCP source still holds MNQ:5m; NQ:15m gone
  });
});

describe("noteBar / noteAck / persistence / replay", () => {
  it("noteBar updates lastSeq/lastTs/contract on the matching key only", async () => {
    const reg = new LiveSubscriptionRegistry(makeDeps());
    await reg.ensure("MNQ", "5m", MCP_SOURCE);
    reg.noteBar(barClose());
    const st = reg.list()[0];
    expect(st.lastSeq).toBe(3);
    expect(st.lastTs).toBe(1789000500);
    reg.noteBar(barClose({ symbol: "NQ" })); // unknown key → no-op, no throw
    expect(reg.list()).toHaveLength(1);
  });

  it("noteAck reconciles a late ack after a timeout", async () => {
    const request = vi.fn(async () => {
      throw new Error("timed out");
    });
    const reg = new LiveSubscriptionRegistry(makeDeps({ request }));
    await reg.ensure("MNQ", "5m", MCP_SOURCE);
    expect(reg.list()[0].acked).toBe(false);
    reg.noteAck(ack());
    const st = reg.list()[0];
    expect(st.acked).toBe(true);
    expect(st.contract).toBe("MNQ 09-26");
    expect(st.lastError).toBeNull();
  });

  it("loadPersisted restores mcp-sourced desired subs as unacked", () => {
    const db = memDb();
    db.prepare(
      "INSERT INTO live_subscriptions (symbol, timeframe, created_at) VALUES (?, ?, ?)",
    ).run("MNQ", "5m", 1);
    db.prepare(
      "INSERT INTO live_subscriptions (symbol, timeframe, created_at) VALUES (?, ?, ?)",
    ).run("NQ", "15m", 2);
    const reg = new LiveSubscriptionRegistry(makeDeps({ db }));
    reg.loadPersisted();
    expect(reg.list()).toHaveLength(2);
    expect(reg.list().every((s) => !s.acked)).toBe(true);
    expect(reg.list().every((s) => s.sources.includes(MCP_SOURCE))).toBe(true);
  });

  it("replayAll re-subscribes every key and counts failures without aborting", async () => {
    const request = vi.fn(async (_type: string, payload: Record<string, unknown>) => {
      if (payload.symbol === "NQ") throw new Error("boom");
      return ack({ symbol: payload.symbol as string, timeframe: payload.timeframe as string });
    });
    const reg = new LiveSubscriptionRegistry(makeDeps({ request }));
    await reg.ensure("MNQ", "5m", MCP_SOURCE);
    await reg.ensure("NQ", "15m", MCP_SOURCE).catch(() => {});
    request.mockClear();
    const res = await reg.replayAll();
    expect(request).toHaveBeenCalledTimes(2);
    expect(res.replayed).toBe(1);
    expect(res.failed).toBe(1);
    const nq = reg.list().find((s) => s.symbol === "NQ")!;
    expect(nq.lastError).toMatch(/boom/);
  });
});
