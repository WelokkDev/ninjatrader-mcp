import { describe, it, expect } from "vitest";
import { pairExecutions } from "../src/trade-source/pair-executions.js";
import type { RawExecution } from "../src/trade-source/types.js";

// Pure-function suite for the FIFO fill-pairing core. Fixtures use small
// integer times and prices; fill() defaults to account "A" / symbol "NQ" so
// most cases read as a single stream, overriding only where cross-stream
// isolation is the point under test.

function fill(
  externalId: string,
  side: "buy" | "sell",
  time: number,
  price: number,
  quantity = 1,
  over: Partial<RawExecution> = {},
): RawExecution {
  return {
    externalId,
    symbol: "NQ",
    time,
    price,
    quantity,
    side,
    commission: null,
    account: "A",
    raw: null,
    ...over,
  };
}

describe("pairExecutions", () => {
  it("returns [] for no fills", () => {
    expect(pairExecutions([])).toEqual([]);
  });

  it("pairs a simple long round trip", () => {
    const trades = pairExecutions([
      fill("E1", "buy", 100, 5000),
      fill("E2", "sell", 200, 5010),
    ]);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.direction).toBe("long");
    expect(t.externalId).toBe("E1"); // keyed by the opening fill
    expect(t.entryTime).toBe(100);
    expect(t.entryPrice).toBe(5000);
    expect(t.exitTime).toBe(200);
    expect(t.exitPrice).toBe(5010);
    expect(t.quantity).toBe(1);
  });

  it("pairs a simple short round trip", () => {
    const trades = pairExecutions([
      fill("E1", "sell", 100, 5000),
      fill("E2", "buy", 200, 4990),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].direction).toBe("short");
    expect(trades[0].entryPrice).toBe(5000);
    expect(trades[0].exitPrice).toBe(4990);
  });

  it("scale-in: weighted entry average and peak quantity", () => {
    const trades = pairExecutions([
      fill("E1", "buy", 100, 5000),
      fill("E2", "buy", 200, 5010),
      fill("E3", "sell", 300, 5020, 2),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].entryPrice).toBe(5005); // (5000 + 5010) / 2
    expect(trades[0].exitPrice).toBe(5020);
    expect(trades[0].quantity).toBe(2); // peak position
    expect(trades[0].exitTime).toBe(300);
  });

  it("partial exits: weighted exit average, closes on the last fill", () => {
    const trades = pairExecutions([
      fill("E1", "buy", 100, 5000, 2),
      fill("E2", "sell", 200, 5010),
      fill("E3", "sell", 300, 5030),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitPrice).toBe(5020); // (5010 + 5030) / 2
    expect(trades[0].exitTime).toBe(300);
    expect(trades[0].quantity).toBe(2);
  });

  it("flip: splits the crossing fill and conserves commission", () => {
    const trades = pairExecutions([
      fill("E1", "buy", 100, 5000, 1, { commission: 2 }),
      fill("E2", "sell", 200, 5010, 2, { commission: 4 }),
      fill("E3", "buy", 300, 5005, 1, { commission: 2 }),
    ]);
    expect(trades).toHaveLength(2);

    const [long, short] = trades;
    expect(long.direction).toBe("long");
    expect(long.externalId).toBe("E1");
    expect(long.exitTime).toBe(200);
    expect(long.exitPrice).toBe(5010);
    expect(long.commission).toBe(4); // 2 (entry) + half of the flip fill's 4

    expect(short.direction).toBe("short");
    expect(short.externalId).toBe("E2"); // remainder opens at the flip fill
    expect(short.entryTime).toBe(200);
    expect(short.entryPrice).toBe(5010);
    expect(short.exitTime).toBe(300);
    expect(short.exitPrice).toBe(5005);
    expect(short.commission).toBe(4); // other half of the flip + 2 (cover)

    const totalFills = 2 + 4 + 2;
    expect(long.commission! + short.commission!).toBe(totalFills);
  });

  it("multi-symbol streams pair independently", () => {
    const trades = pairExecutions([
      fill("N1", "buy", 100, 5000),
      fill("S1", "buy", 110, 200, 1, { symbol: "ES" }),
      fill("N2", "sell", 120, 5010),
      fill("S2", "sell", 130, 210, 1, { symbol: "ES" }),
    ]);
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => [t.symbol, t.entryTime, t.exitTime])).toEqual([
      ["NQ", 100, 120],
      ["ES", 110, 130],
    ]);
  });

  it("fills from different accounts on the same symbol never cross-pair", () => {
    // The real-world hazard: an NT8 DB holds Sim101 and live executions on
    // the same instrument. Interleaved, symbol-only grouping merged these
    // into one qty-2 trade.
    const trades = pairExecutions([
      fill("A1", "buy", 100, 5000, 1, { account: "Sim101" }),
      fill("B1", "buy", 110, 5001, 1, { account: "Live" }),
      fill("A2", "sell", 120, 5005, 1, { account: "Sim101" }),
      fill("B2", "sell", 130, 5006, 1, { account: "Live" }),
    ]);
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => [t.externalId, t.quantity, t.entryTime, t.exitTime])).toEqual([
      ["A1", 1, 100, 120],
      ["B1", 1, 110, 130],
    ]);
  });

  it("null-account fills form their own stream (no cross-pair with named accounts)", () => {
    const trades = pairExecutions([
      fill("E1", "buy", 100, 5000, 1, { account: null }),
      fill("E2", "sell", 200, 5010, 1, { account: "A" }),
    ]);
    // Two residual open positions, not one round trip.
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.exitTime === null)).toBe(true);
    expect(trades.map((t) => t.direction).sort()).toEqual(["long", "short"]);
  });

  it("same-timestamp fills keep input order (stable sort)", () => {
    const trades = pairExecutions([
      fill("E1", "buy", 100, 5000),
      fill("E2", "sell", 100, 5010),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].direction).toBe("long"); // open then close, not sell-first
    expect(trades[0].exitTime).toBe(100);
  });

  it("skips zero-quantity fills without corrupting averages", () => {
    const trades = pairExecutions([
      fill("E1", "buy", 100, 5000),
      fill("E0", "sell", 150, 9999, 0),
      fill("E2", "sell", 200, 5010),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitPrice).toBe(5010);
  });

  it("emits a residual open position with null exit", () => {
    const trades = pairExecutions([fill("E1", "buy", 100, 5000, 2)]);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitTime).toBeNull();
    expect(trades[0].exitPrice).toBeNull();
    expect(trades[0].quantity).toBe(2);
  });

  it("returns trades sorted by entryTime across streams", () => {
    const trades = pairExecutions([
      fill("S1", "buy", 200, 100, 1, { symbol: "ES" }),
      fill("N1", "buy", 100, 5000),
      fill("S2", "sell", 250, 110, 1, { symbol: "ES" }),
      fill("N2", "sell", 300, 5010),
    ]);
    expect(trades.map((t) => t.entryTime)).toEqual([100, 200]);
  });
});
