import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeSchema } from "../../db/schema.js";
import { createLiveFeedRuntime, type LiveFeedRuntime } from "../../live/runtime.js";
import type { TrackedOrder } from "../../live/positions.js";
import {
  assessRisk,
  createGetPositionsHandler,
  createSubscribeLivePositionsHandler,
  createUnsubscribeLivePositionsHandler,
  type PositionsToolsDeps,
} from "../positions.js";

const NOW = 1_789_000_000;

function ord(overrides: Partial<TrackedOrder> = {}): TrackedOrder {
  return {
    orderId: "O1",
    name: "Stop loss",
    instrument: "MNQ 09-26",
    symbol: "MNQ",
    action: "Sell",
    orderType: "StopMarket",
    state: "Working",
    quantity: 2,
    filled: 0,
    stopPrice: 20_950,
    updatedAt: NOW,
    ...overrides,
  };
}

const longPos = {
  instrument: "MNQ 09-26",
  direction: "long" as const,
  quantity: 2,
  averagePrice: 21_000,
  pointValue: 2,
};

describe("assessRisk", () => {
  it("computes full-coverage stop risk and target reward for a long", () => {
    const r = assessRisk(longPos, [
      ord(),
      ord({ orderId: "O2", name: "Profit target", orderType: "Limit", limitPrice: 21_100, stopPrice: undefined }),
    ]);
    expect(r.stopCoverage).toBe("full");
    expect(r.coveredQuantity).toBe(2);
    expect(r.riskDollars).toBe(2 * 50 * 2); // 2 contracts x 50 pts x $2/pt
    expect(r.riskPointsPerContract).toBe(50);
    expect(r.targetCoverage).toBe("full");
    expect(r.rewardDollars).toBe(2 * 100 * 2);
    expect(r.rewardRiskRatio).toBe(2);
  });

  it("reports partial coverage when stop quantity is short", () => {
    const r = assessRisk(longPos, [ord({ quantity: 1 })]);
    expect(r.stopCoverage).toBe("partial");
    expect(r.coveredQuantity).toBe(1);
    expect(r.riskDollars).toBe(1 * 50 * 2);
  });

  it("reports none when no protective stop exists", () => {
    const r = assessRisk(longPos, []);
    expect(r.stopCoverage).toBe("none");
    expect(r.riskDollars).toBeNull();
    expect(r.rewardRiskRatio).toBeNull();
  });

  it("allocates furthest stop first when over-covered (conservative)", () => {
    const r = assessRisk({ ...longPos, quantity: 1 }, [
      ord({ orderId: "near", quantity: 1, stopPrice: 20_990 }), // 10 pts
      ord({ orderId: "far", quantity: 1, stopPrice: 20_980 }), // 20 pts
    ]);
    expect(r.coveredQuantity).toBe(1);
    expect(r.riskDollars).toBe(20 * 2); // the far stop is assumed to fill
  });

  it("ignores wrong-side, wrong-instrument, and fully-filled orders", () => {
    const r = assessRisk(longPos, [
      ord({ action: "Buy" }), // same side as the long — not an exit
      ord({ orderId: "O3", instrument: "ES 09-26" }),
      ord({ orderId: "O4", filled: 2 }),
    ]);
    expect(r.stopCoverage).toBe("none");
  });

  it("matches buy-side protective stops for shorts and MIT targets", () => {
    const r = assessRisk(
      { ...longPos, direction: "short", averagePrice: 21_000 },
      [
        ord({ action: "BuyToCover", stopPrice: 21_040 }),
        ord({
          orderId: "T",
          name: "Profit target",
          action: "BuyToCover",
          orderType: "MIT",
          limitPrice: 20_900,
          stopPrice: undefined,
        }),
      ],
    );
    expect(r.stopCoverage).toBe("full");
    expect(r.riskDollars).toBe(2 * 40 * 2);
    expect(r.targetCoverage).toBe("full");
    expect(r.rewardDollars).toBe(2 * 100 * 2);
  });
});

// ---------- handler tests ----------

const snapshotAccounts = [
  {
    name: "Sim101",
    connection: "Sim",
    connectionStatus: "Connected",
    denomination: "UsDollar",
    realizedPnl: 150,
    cashValue: 25_000,
    positions: [
      {
        instrument: "MNQ 09-26",
        symbol: "MNQ",
        marketPosition: "Long",
        quantity: 2,
        averagePrice: 21_000,
        pointValue: 2,
        tickSize: 0.25,
        marketPrice: 21_025,
        marketPriceTs: NOW,
      },
    ],
    orders: [
      {
        orderId: "S1",
        name: "Stop loss",
        instrument: "MNQ 09-26",
        symbol: "MNQ",
        action: "Sell",
        orderType: "StopMarket",
        state: "Working",
        quantity: 2,
        filled: 0,
        stopPrice: 20_950,
      },
    ],
  },
];

function makeRuntime(over: { request?: ReturnType<typeof vi.fn> } = {}): LiveFeedRuntime {
  const db = new Database(":memory:");
  initializeSchema(db);
  const request =
    over.request ??
    vi.fn(async (type: string) => {
      if (type === "request_positions") {
        return { v: 1, id: "x", type: "positions_response", accounts: snapshotAccounts };
      }
      if (type === "subscribe_positions") {
        return {
          v: 1, id: "x", type: "subscribe_positions_ack",
          accounts: ["Sim101"], alreadyActive: false,
        };
      }
      if (type === "unsubscribe_positions") {
        return { v: 1, id: "x", type: "unsubscribe_positions_ack", removed: true };
      }
      throw new Error(`unexpected ${type}`);
    });
  return createLiveFeedRuntime({
    db,
    request: request as never,
    isConnected: () => true,
    nowUnix: () => NOW,
    nowMs: () => NOW * 1000,
    recorderDir: mkdtempSync(join(tmpdir(), "pos-tools-")),
    onWarn: () => {},
  });
}

function makeDeps(
  runtime: LiveFeedRuntime | null,
  connected = true,
): PositionsToolsDeps {
  return {
    runtime: () => runtime,
    bridgeStatus: () => ({
      connected,
      connectedSince: connected ? NOW - 100 : null,
      lastHeartbeatAt: connected ? NOW - 1 : null,
      ntVersion: connected ? "NT8" : null,
      instruments: [],
      pendingRequests: 0,
      listening: true,
      port: 9472,
    }),
    nowUnix: () => NOW,
  };
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe("get_positions", () => {
  it("errors cleanly when the runtime is not started", async () => {
    const res = await createGetPositionsHandler(makeDeps(null))({});
    const out = parse(res);
    expect(res.isError).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/runtime not started/i);
  });

  it("pulls live and computes unrealized, risk, and R", async () => {
    const runtime = makeRuntime();
    const out = parse(await createGetPositionsHandler(makeDeps(runtime))({}));
    expect(out.ok).toBe(true);
    expect(out.source).toBe("live");
    expect(out.stale).toBeUndefined();
    expect(out.openPositions).toBe(1);

    const accounts = out.accounts as Array<Record<string, unknown>>;
    expect(accounts[0].name).toBe("Sim101");
    expect(accounts[0].isSim).toBe(true);
    expect(accounts[0].realizedPnl).toBe(150);

    const pos = (accounts[0].positions as Array<Record<string, unknown>>)[0];
    expect(pos.direction).toBe("long");
    const unrealized = pos.unrealized as Record<string, unknown>;
    expect(unrealized.points).toBe(25); // 21025 vs 21000
    expect(unrealized.dollars).toBe(100); // 25 pts x 2 qty x $2

    const risk = pos.risk as Record<string, unknown>;
    expect(risk.stopCoverage).toBe("full");
    expect(risk.riskDollars).toBe(200);
    expect(risk.rMultiple).toBe(0.5);

    const liveTrade = pos.liveTrade as Record<string, unknown>;
    expect(liveTrade.preExisting).toBe(true); // pull attached mid-trade
  });

  it("returns stale last-known state when the bridge is down", async () => {
    const runtime = makeRuntime();
    // Seed state via a sync, then go offline.
    runtime.handlePositionSync({
      v: 1,
      type: "position_sync",
      accounts: snapshotAccounts as never,
      seq: 1,
      ts: NOW - 60,
    });
    const out = parse(await createGetPositionsHandler(makeDeps(runtime, false))({}));
    expect(out.ok).toBe(true);
    expect(out.source).toBe("last-known");
    expect(out.stale).toBe(true);
    expect(out.warning).toMatch(/do not assume flat/i);
    expect(out.openPositions).toBe(1);
  });
});

describe("subscribe/unsubscribe_live_positions", () => {
  it("subscribes and reports the ack truthfully", async () => {
    const runtime = makeRuntime();
    const out = parse(
      await createSubscribeLivePositionsHandler(makeDeps(runtime))({}),
    );
    expect(out.ok).toBe(true);
    expect(out.accounts).toEqual(["Sim101"]);
    expect(out.alreadyActive).toBe(false);
    expect(runtime.positions.desired()).toBe(true);
  });

  it("unsubscribes and persists the OFF state", async () => {
    const runtime = makeRuntime();
    await createSubscribeLivePositionsHandler(makeDeps(runtime))({});
    const out = parse(
      await createUnsubscribeLivePositionsHandler(makeDeps(runtime))({}),
    );
    expect(out.ok).toBe(true);
    expect(out.removed).toBe(true);
    expect(runtime.positions.desired()).toBe(false);
  });
});
