import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/db/schema.js";
import { createLedger, type Ledger } from "../src/db/ledger.js";
import { ingestTrades } from "../src/trade-source/ingest.js";
import type { RawTrade, TradeSource } from "../src/trade-source/types.js";

// ingestTrades + Ledger.insertTradeIfAbsent over an in-memory SQLite ledger.
// A fake TradeSource stands in for the NinjaTrader adapter (its own behavior
// is covered in ninjatrader-source.test.ts).

function rawTrade(over: Partial<RawTrade> & { externalId: string }): RawTrade {
  return {
    source: "", // stamped by fakeSource, like a real adapter
    symbol: "NQ",
    direction: "long",
    entryTime: 1_000,
    entryPrice: 5000,
    exitTime: 2_000,
    exitPrice: 5010,
    quantity: 1,
    commission: 2,
    realizedPnl: null,
    raw: null,
    ...over,
  };
}

function fakeSource(id: string, trades: RawTrade[]): TradeSource {
  return {
    id,
    capabilities: { serverSideRange: false, realizedPnl: false, commission: true },
    async fetchTrades() {
      return trades.map((t) => ({ ...t, source: id }));
    },
  };
}

const RANGE = { from: 0, to: 10_000 };

describe("ingestTrades", () => {
  let ledger: Ledger;

  beforeEach(() => {
    const db = new Database(":memory:");
    initializeSchema(db);
    ledger = createLedger(db);
  });

  it("ingests closed trades and skips open ones", async () => {
    const source = fakeSource("ninjatrader", [
      rawTrade({ externalId: "A" }),
      rawTrade({ externalId: "B", exitTime: null, exitPrice: null }),
    ]);
    const result = await ingestTrades(source, ledger, RANGE);
    expect(result).toEqual({ fetched: 2, inserted: 1 });
    expect(ledger.getTrade("ninjatrader:A")).toBeDefined();
    expect(ledger.getTrade("ninjatrader:B")).toBeUndefined();
  });

  it("re-ingesting the same range is idempotent", async () => {
    const source = fakeSource("ninjatrader", [rawTrade({ externalId: "A" })]);
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 1 });
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 0 });
    expect(ledger.listTrades({ mode: "live" })).toHaveLength(1);
  });

  it("does not update an existing row (insert-if-absent, not upsert)", async () => {
    await ingestTrades(fakeSource("ninjatrader", [rawTrade({ externalId: "A", entryPrice: 5000 })]), ledger, RANGE);
    await ingestTrades(fakeSource("ninjatrader", [rawTrade({ externalId: "A", entryPrice: 9999 })]), ledger, RANGE);
    expect(ledger.getTrade("ninjatrader:A")!.entryPrice).toBe(5000);
  });

  it("trades from different sources with the same externalId both insert", async () => {
    // Regression: the dedupe lookup was source-blind (`WHERE external_id = ?`
    // across ALL sources), so the second source's trade was silently dropped.
    await ingestTrades(fakeSource("ninjatrader", [rawTrade({ externalId: "X" })]), ledger, RANGE);
    await ingestTrades(fakeSource("ibkr", [rawTrade({ externalId: "X" })]), ledger, RANGE);
    expect(ledger.getTrade("ninjatrader:X")).toBeDefined();
    expect(ledger.getTrade("ibkr:X")).toBeDefined();
    expect(ledger.listTrades({ mode: "live" })).toHaveLength(2);
  });
});
