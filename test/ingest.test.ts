import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/db/schema.js";
import { createLedger, type Ledger } from "../src/db/ledger.js";
import { ingestTrades } from "../src/trade-source/ingest.js";
import type { RawTrade, TradeSource } from "../src/trade-source/types.js";

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
    filledQuantity: 1,
    commission: 2,
    account: "Sim101",
    ...over,
  };
}

function fakeSource(id: string, trades: RawTrade[]): TradeSource {
  return {
    id,
    async fetchTrades() {
      return trades.map((t) => ({ ...t, source: id }));
    },
  };
}

const RANGE = { from: 0, to: 10_000 };

describe("ingestTrades", () => {
  let db: Database.Database;
  let ledger: Ledger;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    ledger = createLedger(db);
  });

  it("ingests closed trades and skips open ones", async () => {
    const source = fakeSource("ninjatrader", [
      rawTrade({ externalId: "A" }),
      rawTrade({ externalId: "B", exitTime: null, exitPrice: null }),
    ]);
    const result = await ingestTrades(source, ledger, RANGE);
    expect(result).toEqual({ fetched: 2, inserted: 1, filled: 0, mismatched: 0 });
    expect(ledger.getTrade("ninjatrader:A")).toBeDefined();
    expect(ledger.getTrade("ninjatrader:B")).toBeUndefined();
  });

  it("stores what the source reports about the round trip, size and commission included", async () => {
    const source = fakeSource("ninjatrader", [
      rawTrade({ externalId: "A", direction: "short", quantity: 3, filledQuantity: 5, commission: 12.6 }),
    ]);
    await ingestTrades(source, ledger, RANGE);
    expect(ledger.getTrade("ninjatrader:A")).toMatchObject({
      tradeId: "ninjatrader:A",
      source: "ninjatrader",
      externalId: "A",
      symbol: "NQ",
      direction: "short",
      quantity: 3,
      filledQuantity: 5,
      account: "Sim101",
      entryTime: 1_000,
      entryPrice: 5000,
      exitTime: 2_000,
      exitPrice: 5010,
      commission: 12.6,
    });
  });

  it("re-ingesting the same range is idempotent", async () => {
    const source = fakeSource("ninjatrader", [rawTrade({ externalId: "A" })]);
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 1, filled: 0, mismatched: 0 });
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 0, filled: 0, mismatched: 0 });
    expect(ledger.listTrades()).toHaveLength(1);
  });

  it("never overwrites a stored value", async () => {
    await ingestTrades(fakeSource("ninjatrader", [rawTrade({ externalId: "A", account: "Sim101" })]), ledger, RANGE);
    await ingestTrades(fakeSource("ninjatrader", [rawTrade({ externalId: "A", account: "Live" })]), ledger, RANGE);
    expect(ledger.getTrade("ninjatrader:A")!.account).toBe("Sim101");
  });

  it("re-importing a row with nothing to fill does not write", async () => {
    const source = fakeSource("ninjatrader", [rawTrade({ externalId: "A" })]);
    await ingestTrades(source, ledger, RANGE);
    db.pragma("query_only = ON");
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 0, filled: 0, mismatched: 0 });
  });

  it("leaves a stored row that is no longer the round trip the source reports untouched", async () => {
    await ingestTrades(fakeSource("ninjatrader", [rawTrade({ externalId: "A", account: null })]), ledger, RANGE);

    const source = fakeSource("ninjatrader", [rawTrade({ externalId: "A", exitPrice: 5020 })]);
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 0, filled: 0, mismatched: 1 });
    expect(ledger.getTrade("ninjatrader:A")).toMatchObject({ exitPrice: 5010, account: null });
  });

  it("fills the columns an older import left empty, once", async () => {
    const older = rawTrade({ externalId: "A", account: null });
    await ingestTrades(fakeSource("ninjatrader", [older]), ledger, RANGE);
    db.prepare("UPDATE trades SET quantity = NULL, filled_quantity = NULL, commission = NULL").run();

    const source = fakeSource("ninjatrader", [rawTrade({ externalId: "A", quantity: 2, filledQuantity: 3 })]);
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 0, filled: 1, mismatched: 0 });
    expect(ledger.getTrade("ninjatrader:A")).toMatchObject({
      quantity: 2, filledQuantity: 3, commission: 2, account: "Sim101",
    });
    expect(await ingestTrades(source, ledger, RANGE)).toEqual({ fetched: 1, inserted: 0, filled: 0, mismatched: 0 });
  });

  it("trades from different sources with the same externalId both insert", async () => {
    // Regression: the dedupe lookup was source-blind (`WHERE external_id = ?`
    // across ALL sources), so the second source's trade was silently dropped.
    await ingestTrades(fakeSource("ninjatrader", [rawTrade({ externalId: "X" })]), ledger, RANGE);
    await ingestTrades(fakeSource("ibkr", [rawTrade({ externalId: "X" })]), ledger, RANGE);
    expect(ledger.getTrade("ninjatrader:X")).toBeDefined();
    expect(ledger.getTrade("ibkr:X")).toBeDefined();
    expect(ledger.listTrades()).toHaveLength(2);
  });
});
