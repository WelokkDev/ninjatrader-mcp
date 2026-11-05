import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createLedger, type Ledger, type Trade } from "../../db/ledger.js";
import { createGetTradesHandler, createSyncTradesHandler } from "../get-trades.js";
import type { RawTrade, TradeSource } from "../../trade-source/types.js";

function trade(externalId: string, account: string | null): Trade {
  return {
    tradeId: `ninjatrader:${externalId}`, source: "ninjatrader", externalId,
    symbol: "NQ", direction: "long", quantity: 1, filledQuantity: 1,
    entryTime: 1_000, entryPrice: 5000, exitTime: 2_000, exitPrice: 5010,
    commission: 2, account, createdAt: 3_000,
  };
}

const noSource = (): TradeSource => {
  throw new Error("no source in this test");
};

describe("get_trades account filter", () => {
  let ledger: Ledger;

  beforeEach(() => {
    const db = new Database(":memory:");
    initializeSchema(db);
    ledger = createLedger(db);
    ledger.importTrade(trade("A", "Sim101"));
    ledger.importTrade(trade("B", "APEX-1"));
  });

  const ids = async (args: { account?: string }) => {
    const result = await createGetTradesHandler({ ledger, resolveSource: noSource })({ from: 0, to: 10_000, ...args });
    return (JSON.parse(result.content[0].text) as { trades: Trade[] }).trades.map((t) => t.externalId);
  };

  it("returns every account when account is omitted or empty", async () => {
    expect(await ids({})).toEqual(["A", "B"]);
    expect(await ids({ account: "" })).toEqual(["A", "B"]);
  });

  it("returns only the named account's trades", async () => {
    expect(await ids({ account: "APEX-1" })).toEqual(["B"]);
  });
});

describe("get_trades on-demand import", () => {
  let ledger: Ledger;
  let requested: Array<string | undefined>;

  const sourceOf = (fills: Trade[]) => (acct?: string): TradeSource => {
    requested.push(acct);
    return {
      id: "ninjatrader",
      async fetchTrades() {
        return fills
          .filter((t) => !acct || t.account === acct)
          .map((t): RawTrade => ({ ...t, quantity: t.quantity!, filledQuantity: t.filledQuantity! }));
      },
    };
  };

  const call = async (fills: Trade[], account?: string) => {
    const result = await createGetTradesHandler({ ledger, resolveSource: sourceOf(fills) })({ from: 0, to: 10_000, account });
    return JSON.parse(result.content[0].text) as { trades: Trade[]; warning?: string };
  };

  beforeEach(() => {
    const db = new Database(":memory:");
    initializeSchema(db);
    ledger = createLedger(db);
    requested = [];
  });

  it("imports the account asked for, not the configured one", async () => {
    await call([trade("B", "APEX-1")], "APEX-1");
    expect(requested).toEqual(["APEX-1"]);
  });

  it("fills in older rows with no account before filtering", async () => {
    ledger.importTrade(trade("A", null));
    ledger.importTrade(trade("B", "APEX-1"));

    const out = await call([trade("A", "APEX-1"), trade("B", "APEX-1")], "APEX-1");

    expect(out.trades.map((t) => t.externalId)).toEqual(["A", "B"]);
    expect(out.warning).toBeUndefined();
  });

  it("warns about rows the import could not attribute", async () => {
    ledger.importTrade(trade("A", null));
    ledger.importTrade(trade("B", "APEX-1"));

    const out = await call([trade("B", "APEX-1")], "APEX-1");

    expect(out.trades.map((t) => t.externalId)).toEqual(["B"]);
    expect(out.warning).toBe("1 trade(s) in range have no recorded account and were left out");
  });

  it("warns when a stored trade is no longer the round trip NT8 reports, from both tools", async () => {
    ledger.importTrade(trade("A", "Sim101"));
    const reported = [{ ...trade("A", "Sim101"), exitPrice: 5020 }];

    const out = await createGetTradesHandler({ ledger, resolveSource: sourceOf(reported) })({ from: 0, to: 10_000, sync: true });
    const synced = await createSyncTradesHandler({ ledger, resolveSource: sourceOf(reported) })({ from: 0, to: 10_000 });

    const warning = "1 stored trade(s) differ from what NT8 reports now and were left untouched";
    expect(JSON.parse(out.content[0].text)).toMatchObject({ count: 1, warning });
    expect(JSON.parse(synced.content[0].text)).toEqual({ fetched: 1, inserted: 0, filled: 0, mismatched: 1, warning });
  });

  it("names the accounts in range when the one asked for matches nothing", async () => {
    ledger.importTrade(trade("A", "Sim101"));
    ledger.importTrade(trade("B", "APEX-1"));

    const out = await call([], "apex-1");

    expect(out.trades).toEqual([]);
    expect(out.warning).toBe('no trades for account "apex-1"; accounts in range: Sim101, APEX-1');
  });
});
