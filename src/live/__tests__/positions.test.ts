import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import {
  PositionFeed,
  looksLikeSimAccount,
  maePoints,
  mfePoints,
  type PositionBroadcast,
} from "../positions.js";
import type {
  AccountSnapshotPayload,
  PositionEventMessage,
  PositionPayload,
  PositionSyncMessage,
} from "../../bridge/protocol.js";

const NOW = 1_789_000_000;

function makeFeed(over: {
  request?: ReturnType<typeof vi.fn>;
  connected?: boolean;
  onBroadcast?: (b: PositionBroadcast) => void;
} = {}) {
  const db = new Database(":memory:");
  initializeSchema(db);
  const request =
    over.request ??
    vi.fn(async (type: string) => {
      if (type === "subscribe_positions") {
        return { v: 1, id: "x", type: "subscribe_positions_ack", accounts: ["Sim101"], alreadyActive: false };
      }
      if (type === "unsubscribe_positions") {
        return { v: 1, id: "x", type: "unsubscribe_positions_ack", removed: true };
      }
      if (type === "request_positions") {
        return { v: 1, id: "x", type: "positions_response", accounts: [] };
      }
      throw new Error(`unexpected request ${type}`);
    });
  const feed = new PositionFeed({
    db,
    request: request as never,
    isConnected: () => over.connected ?? true,
    nowUnix: () => NOW,
    nowMs: () => NOW * 1000,
    ...(over.onBroadcast ? { onBroadcast: over.onBroadcast } : {}),
  });
  feed.loadPersisted();
  return { feed, db, request };
}

function pos(overrides: Partial<PositionPayload> = {}): PositionPayload {
  return {
    instrument: "MNQ 09-26",
    symbol: "MNQ",
    marketPosition: "Long",
    quantity: 2,
    averagePrice: 21_000,
    pointValue: 2,
    tickSize: 0.25,
    ...overrides,
  };
}

function account(overrides: Partial<AccountSnapshotPayload> = {}): AccountSnapshotPayload {
  return {
    name: "Sim101",
    connection: "Sim",
    connectionStatus: "Connected",
    denomination: "UsDollar",
    realizedPnl: 150,
    positions: [],
    orders: [],
    ...overrides,
  };
}

function sync(accounts: AccountSnapshotPayload[], seq?: number): PositionSyncMessage {
  return {
    v: 1,
    type: "position_sync",
    accounts,
    ...(seq !== undefined ? { seq } : {}),
    ts: NOW,
    reason: "test",
  };
}

function posEvent(
  p: PositionPayload,
  seq: number,
  operation = "Update",
): PositionEventMessage {
  return {
    v: 1,
    type: "position_event",
    account: "Sim101",
    kind: "position",
    seq,
    ts: NOW + seq,
    position: p,
    operation,
  };
}

describe("looksLikeSimAccount", () => {
  it("flags sim-style names and not live-style names", () => {
    expect(looksLikeSimAccount("Sim101")).toBe(true);
    expect(looksLikeSimAccount("Playback101")).toBe(true);
    expect(looksLikeSimAccount("APEX-12345")).toBe(false);
  });
});

describe("mae/mfe math", () => {
  it("computes long-side excursions vs average entry", () => {
    expect(maePoints("long", 100, 95)).toBe(5);
    expect(mfePoints("long", 100, 112)).toBe(12);
    expect(maePoints("long", 100, 104)).toBe(0); // never went adverse
  });
  it("computes short-side excursions vs average entry", () => {
    expect(maePoints("short", 100, 106)).toBe(6);
    expect(mfePoints("short", 100, 91)).toBe(9);
  });
  it("returns null when entry or extreme is unknown", () => {
    expect(maePoints("long", null, 95)).toBeNull();
    expect(mfePoints("long", 100, null)).toBeNull();
  });
});

describe("desired state persistence", () => {
  it("persists subscribe across feed instances", async () => {
    const { feed, db } = makeFeed();
    await feed.subscribe();
    expect(feed.desired()).toBe(true);

    const feed2 = new PositionFeed({
      db,
      request: vi.fn() as never,
      isConnected: () => false,
      nowUnix: () => NOW,
    });
    feed2.loadPersisted();
    expect(feed2.desired()).toBe(true);
  });

  it("records desired ON with an error when the bridge is down", async () => {
    const { feed } = makeFeed({ connected: false });
    const res = await feed.subscribe();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected/i);
    expect(feed.desired()).toBe(true);
  });

  it("appends the recompile hint on subscribe timeout", async () => {
    const request = vi.fn(async () => {
      throw new Error("Request subscribe_positions (x) timed out after 15000ms");
    });
    const { feed } = makeFeed({ request });
    const res = await feed.subscribe();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/recompile/i);
  });

  it("unsubscribe persists OFF even when upstream fails", async () => {
    const request = vi.fn(async (type: string) => {
      if (type === "subscribe_positions") {
        return { accounts: ["Sim101"], alreadyActive: false };
      }
      throw new Error("boom");
    });
    const { feed } = makeFeed({ request });
    await feed.subscribe();
    const res = await feed.unsubscribe();
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(false);
    expect(res.error).toMatch(/boom/);
    expect(feed.desired()).toBe(false);
  });
});

describe("sync application", () => {
  it("replaces account state and opens pre-existing trades", () => {
    const { feed } = makeFeed();
    feed.handleSync(sync([account({ positions: [pos()] })], 1));

    const accounts = feed.accountsView();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].positions.size).toBe(1);

    const trade = feed.tradeFor("Sim101", "MNQ 09-26");
    expect(trade).not.toBeNull();
    expect(trade!.openedAt).toBeNull(); // pre-existing: entry time unknown
    expect(trade!.direction).toBe("long");
  });

  it("closes trades whose position vanished from the snapshot", () => {
    const { feed } = makeFeed();
    feed.handleSync(sync([account({ positions: [pos()] })], 1));
    feed.handleSync(sync([account({ positions: [] })], 2));
    expect(feed.tradeFor("Sim101", "MNQ 09-26")).toBeNull();
    expect(feed.recentClosedTrades()).toHaveLength(1);
    expect(feed.recentClosedTrades()[0].closeReason).toBe("sync");
  });

  it("drops accounts missing from the snapshot and closes their trades", () => {
    const { feed } = makeFeed();
    feed.handleSync(sync([account({ positions: [pos()] })], 1));
    feed.handleSync(sync([account({ name: "Other" })], 2));
    expect(feed.accountsView().map((a) => a.name)).toEqual(["Other"]);
    expect(feed.recentClosedTrades()[0].closeReason).toBe("account-gone");
  });
});

describe("event lifecycle", () => {
  it("tracks flat -> open -> scale -> flat as one trade", () => {
    const { feed } = makeFeed();
    feed.handleEvent(posEvent(pos({ quantity: 1 }), 1, "Add"));
    let trade = feed.tradeFor("Sim101", "MNQ 09-26");
    expect(trade).not.toBeNull();
    expect(trade!.openedAt).toBe(NOW + 1);

    feed.handleEvent(posEvent(pos({ quantity: 3, averagePrice: 21_010 }), 2));
    trade = feed.tradeFor("Sim101", "MNQ 09-26");
    expect(trade!.quantity).toBe(3);
    expect(trade!.peakQuantity).toBe(3);
    expect(trade!.averagePrice).toBe(21_010);

    feed.handleEvent(posEvent(pos({ marketPosition: "Flat", quantity: 0 }), 3, "Remove"));
    expect(feed.tradeFor("Sim101", "MNQ 09-26")).toBeNull();
    const closed = feed.recentClosedTrades();
    expect(closed).toHaveLength(1);
    expect(closed[0].peakQuantity).toBe(3);
    expect(closed[0].closeReason).toBe("flat");
    expect(closed[0].preExisting).toBe(false);
  });

  it("splits a reversal into two trades", () => {
    const { feed } = makeFeed();
    feed.handleEvent(posEvent(pos({ quantity: 2 }), 1, "Add"));
    feed.handleEvent(
      posEvent(pos({ marketPosition: "Short", quantity: 1, averagePrice: 21_050 }), 2),
    );
    const closed = feed.recentClosedTrades();
    expect(closed).toHaveLength(1);
    expect(closed[0].direction).toBe("long");
    expect(closed[0].closeReason).toBe("reversal");
    const trade = feed.tradeFor("Sim101", "MNQ 09-26");
    expect(trade!.direction).toBe("short");
  });

  it("dedupes executions by id and appends fills to the open trade", () => {
    const { feed } = makeFeed();
    feed.handleEvent(posEvent(pos({ quantity: 1 }), 1, "Add"));
    const exec: PositionEventMessage = {
      v: 1,
      type: "position_event",
      account: "Sim101",
      kind: "execution",
      seq: 2,
      ts: NOW + 2,
      execution: {
        executionId: "E1",
        orderId: "O1",
        instrument: "MNQ 09-26",
        symbol: "MNQ",
        side: "Long",
        quantity: 1,
        price: 21_001,
        time: NOW + 2,
      },
    };
    feed.handleEvent(exec);
    feed.handleEvent({ ...exec, seq: 3 }); // replayed duplicate
    const trade = feed.tradeFor("Sim101", "MNQ 09-26");
    expect(trade!.fills).toHaveLength(1);
    expect(feed.status().executionsSeen).toBe(1);
  });

  it("tracks working orders and drops terminal ones", () => {
    const { feed } = makeFeed();
    const order = (state: string): PositionEventMessage => ({
      v: 1,
      type: "position_event",
      account: "Sim101",
      kind: "order",
      seq: 1,
      ts: NOW,
      order: {
        orderId: "O1",
        name: "Stop loss",
        instrument: "MNQ 09-26",
        symbol: "MNQ",
        action: "Sell",
        orderType: "StopMarket",
        state,
        quantity: 2,
        filled: 0,
        stopPrice: 20_950,
      },
    });
    feed.handleEvent(order("Working"));
    expect(feed.accountsView()[0].orders.size).toBe(1);
    feed.handleEvent(order("Cancelled"));
    expect(feed.accountsView()[0].orders.size).toBe(0);
  });
});

describe("excursion tracking from bars", () => {
  it("extends MAE/MFE from live bar closes on the trade's symbol", () => {
    const { feed } = makeFeed();
    feed.handleEvent(posEvent(pos({ quantity: 2, averagePrice: 21_000 }), 1, "Add"));
    feed.noteBar({
      symbol: "MNQ",
      timeframe: "5m",
      candle: { timestamp: NOW, open: 21_000, high: 21_030, low: 20_985, close: 21_020, volume: 10 },
      receivedAtMs: (NOW + 300) * 1000,
    });
    const trade = feed.tradeFor("Sim101", "MNQ 09-26")!;
    expect(trade.maxFavorablePrice).toBe(21_030);
    expect(trade.maxAdversePrice).toBe(20_985);
    expect(feed.lastPriceFor("MNQ")).toMatchObject({ price: 21_020, source: "bar" });
  });

  it("ignores backfill bars for price marks and excursions", () => {
    const { feed } = makeFeed();
    feed.handleEvent(posEvent(pos({ quantity: 1 }), 1, "Add"));
    feed.noteBar({
      symbol: "MNQ",
      timeframe: "5m",
      candle: { timestamp: NOW - 3600, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      receivedAtMs: NOW * 1000,
      backfill: true,
    });
    expect(feed.lastPriceFor("MNQ")).toBeNull();
    expect(feed.tradeFor("Sim101", "MNQ 09-26")!.maxAdversePrice).toBe(21_000);
  });
});

describe("seq gap handling", () => {
  it("counts the gap and pulls a resync", async () => {
    const request = vi.fn(async (type: string) => {
      if (type === "request_positions") {
        return { v: 1, id: "x", type: "positions_response", accounts: [account()] };
      }
      throw new Error(`unexpected ${type}`);
    });
    const { feed } = makeFeed({ request });
    feed.handleEvent(posEvent(pos({ quantity: 1 }), 1, "Add"));
    feed.handleEvent(posEvent(pos({ quantity: 2 }), 5)); // 2..4 lost
    expect(feed.status().seqGaps).toBe(1);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("request_positions", {}, expect.anything());
    });
  });

  it("treats a seq reset (addon restart) as a new stream, not a gap", () => {
    const { feed } = makeFeed();
    feed.handleEvent(posEvent(pos({ quantity: 1 }), 10, "Add"));
    feed.handleEvent(posEvent(pos({ quantity: 2 }), 1));
    expect(feed.status().seqGaps).toBe(0);
    expect(feed.status().lastSeq).toBe(1);
  });
});

describe("broadcasts", () => {
  it("publishes events, syncs, and trade_closed summaries", () => {
    const seen: PositionBroadcast[] = [];
    const { feed } = makeFeed({ onBroadcast: (b) => seen.push(b) });
    feed.handleSync(sync([account({ positions: [pos()] })], 1));
    feed.handleEvent(posEvent(pos({ marketPosition: "Flat", quantity: 0 }), 2, "Remove"));
    const types = seen.map((b) => b.type);
    expect(types).toContain("position_sync");
    expect(types).toContain("trade_closed");
    expect(types).toContain("position_event");
    const closed = seen.find((b) => b.type === "trade_closed");
    expect(closed && "trade" in closed && closed.trade.preExisting).toBe(true);
  });
});

describe("replay", () => {
  it("re-subscribes upstream when desired is on", async () => {
    const { feed, request } = makeFeed();
    await feed.subscribe();
    request.mockClear();
    await feed.replay();
    expect(request).toHaveBeenCalledWith("subscribe_positions", {}, expect.anything());
  });

  it("enforces OFF upstream when desired is off", async () => {
    const { feed, request } = makeFeed();
    await feed.replay();
    expect(request).toHaveBeenCalledWith("unsubscribe_positions", {}, expect.anything());
    expect(request).not.toHaveBeenCalledWith("subscribe_positions", {}, expect.anything());
  });
});
