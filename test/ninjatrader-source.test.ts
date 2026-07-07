import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NinjaTraderSource, NT_SCHEMA } from "../src/trade-source/ninjatrader.js";

// Integration tests for the NinjaTrader adapter against a fixture NinjaTrader.sqlite
// Exercises the full path: snapshot copy, four-tablejoin, side decode, pairing, range filter.

interface FixtureFill {
  execId: string;
  symbol: "NQ" | "ES";
  account: "Sim101" | "Live";
  time: number; // unix seconds — converted to ticks via NT_SCHEMA.unixToTicks
  timeTicks?: number; // raw .NET ticks override (for pinning real observed values)
  price: number;
  qty: number;
  orderAction: number | null; // null → Orders row exists with NULL OrderAction
  omitOrderRow?: boolean; // true → no Orders row at all (LEFT JOIN miss)
  commission?: number;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function buildFixture(fills: FixtureFill[]): string {
  const dir = mkdtempSync(join(tmpdir(), "nt-fixture-"));
  dirs.push(dir);
  const dbPath = join(dir, "NinjaTrader.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE MasterInstruments (Id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE Instruments (Id INTEGER PRIMARY KEY, MasterInstrument INTEGER);
    CREATE TABLE Accounts (Id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE Orders (Id INTEGER PRIMARY KEY AUTOINCREMENT, OrderId TEXT, OrderAction INTEGER);
    CREATE TABLE Executions (
      Id INTEGER PRIMARY KEY AUTOINCREMENT, ExecutionId TEXT, Instrument INTEGER,
      Price REAL, Quantity INTEGER, MarketPosition INTEGER, Time INTEGER,
      Commission REAL, Fee REAL, OrderId TEXT, Account INTEGER
    );
  `);
  db.prepare(`INSERT INTO MasterInstruments (Id, Name) VALUES (1, 'NQ'), (2, 'ES')`).run();
  db.prepare(`INSERT INTO Instruments (Id, MasterInstrument) VALUES (10, 1), (20, 2)`).run();
  db.prepare(`INSERT INTO Accounts (Id, Name) VALUES (1, 'Sim101'), (2, 'Live')`).run();

  const instr = { NQ: 10, ES: 20 } as const;
  const acct = { Sim101: 1, Live: 2 } as const;
  const insertOrder = db.prepare(`INSERT INTO Orders (OrderId, OrderAction) VALUES (?, ?)`);
  const insertExec = db.prepare(
    `INSERT INTO Executions
       (ExecutionId, Instrument, Price, Quantity, MarketPosition, Time, Commission, Fee, OrderId, Account)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    const orderId = `O${i}`;
    if (!f.omitOrderRow) insertOrder.run(orderId, f.orderAction);
    insertExec.run(
      f.execId,
      instr[f.symbol],
      f.price,
      f.qty,
      0,
      f.timeTicks ?? NT_SCHEMA.unixToTicks(f.time),
      f.commission ?? 0,
      0,
      orderId,
      acct[f.account],
    );
  }
  db.close();
  return dbPath;
}

// Wide-open range: pairing always sees full history; this filters nothing out.
const FULL = { from: 0, to: 4_102_444_800 }; // through year 2100

describe("NinjaTraderSource.fetchTrades", () => {
  it("decodes Executions.Time ticks as UTC (pinned to verified ground truth)", async () => {
    // Ground truth from the real NT8 install (2026-06-30, PC tz = Eastern)
    const dbPath = buildFixture([
      {
        execId: "1fb7acf9", symbol: "NQ", account: "Sim101",
        time: 0, timeTicks: 639184401078924300,
        price: 30647, qty: 1, orderAction: 0, // Buy
      },
      {
        execId: "75126860", symbol: "NQ", account: "Sim101",
        time: 0, timeTicks: 639184405146027500,
        price: 30642, qty: 1, orderAction: 2, // chart "Close" sell → SellShort
      },
    ]);
    const trades = await new NinjaTraderSource({ dbPath }).fetchTrades(FULL);

    expect(trades).toHaveLength(1);
    expect(trades[0].entryTime).toBe(Date.UTC(2026, 5, 30, 18, 15, 7) / 1000);
    expect(trades[0].exitTime).toBe(Date.UTC(2026, 5, 30, 18, 21, 54) / 1000);
    // OrderAction=2 (SellShort) must still read as a sell → the round trip stays a single long, not a long plus a phantom short entry.
    expect(trades[0].direction).toBe("long");
    expect(trades[0].entryPrice).toBe(30647);
    expect(trades[0].exitPrice).toBe(30642);
  });

  it("throws when an execution's Orders row is missing (side unresolvable)", async () => {
    const dbPath = buildFixture([
      {
        execId: "ORPHAN1", symbol: "NQ", account: "Sim101",
        time: 1_000, price: 5000, qty: 1,
        orderAction: null, omitOrderRow: true,
      },
    ]);
    const src = new NinjaTraderSource({ dbPath });
    // Pre-fix, Number(null) === 0 silently decoded this as a Buy.
    await expect(src.fetchTrades(FULL)).rejects.toThrow(/OrderAction/);
    await expect(src.fetchTrades(FULL)).rejects.toThrow(/ORPHAN1/);
  });

  it("throws when Orders.OrderAction is NULL", async () => {
    const dbPath = buildFixture([
      {
        execId: "NULLACT1", symbol: "NQ", account: "Sim101",
        time: 1_000, price: 5000, qty: 1, orderAction: null,
      },
    ]);
    await expect(new NinjaTraderSource({ dbPath }).fetchTrades(FULL)).rejects.toThrow(
      /NULLACT1/,
    );
  });

  it("maps OrderAction {2: SellShort, 3: BuyToCover} to a short round trip", async () => {
    const dbPath = buildFixture([
      { execId: "S1", symbol: "NQ", account: "Sim101", time: 1_000, price: 5000, qty: 1, orderAction: 2 },
      { execId: "S2", symbol: "NQ", account: "Sim101", time: 2_000, price: 4990, qty: 1, orderAction: 3 },
    ]);
    const trades = await new NinjaTraderSource({ dbPath }).fetchTrades(FULL);
    expect(trades).toHaveLength(1);
    expect(trades[0].direction).toBe("short");
    expect(trades[0].entryPrice).toBe(5000);
    expect(trades[0].exitPrice).toBe(4990);
  });

  it("does not fabricate trades when the range starts mid-trade (anchoring regression)", async () => {
    // Two real longs: 1000→2000 and 3000→4000.
    const dbPath = buildFixture([
      { execId: "E1", symbol: "NQ", account: "Sim101", time: 1_000, price: 5000, qty: 1, orderAction: 0 },
      { execId: "E2", symbol: "NQ", account: "Sim101", time: 2_000, price: 5010, qty: 1, orderAction: 1 },
      { execId: "E3", symbol: "NQ", account: "Sim101", time: 3_000, price: 5020, qty: 1, orderAction: 0 },
      { execId: "E4", symbol: "NQ", account: "Sim101", time: 4_000, price: 5030, qty: 1, orderAction: 1 },
    ]);
    const src = new NinjaTraderSource({ dbPath });

    const full = await src.fetchTrades({ from: 0, to: 10_000 });
    expect(full.map((t) => [t.direction, t.entryTime, t.exitTime])).toEqual([
      ["long", 1_000, 2_000],
      ["long", 3_000, 4_000],
    ]);

    const cut = await src.fetchTrades({ from: 1_500, to: 10_000 });
    expect(cut.map((t) => [t.direction, t.entryTime, t.exitTime])).toEqual([
      ["long", 3_000, 4_000],
    ]);
  });

  it("selects trades by entryTime — an exit outside the range does not exclude the trade", async () => {
    const dbPath = buildFixture([
      { execId: "E1", symbol: "NQ", account: "Sim101", time: 1_000, price: 5000, qty: 1, orderAction: 0 },
      { execId: "E2", symbol: "NQ", account: "Sim101", time: 2_000, price: 5010, qty: 1, orderAction: 1 },
    ]);
    const trades = await new NinjaTraderSource({ dbPath }).fetchTrades({ from: 0, to: 1_500 });
    expect(trades).toHaveLength(1);
    expect(trades[0].entryTime).toBe(1_000);
    expect(trades[0].exitTime).toBe(2_000); // exit past `to`, still the real exit
  });

  it("applies the account option as a SQL-level filter", async () => {
    const dbPath = buildFixture([
      { execId: "A1", symbol: "NQ", account: "Sim101", time: 1_000, price: 5000, qty: 1, orderAction: 0 },
      { execId: "A2", symbol: "NQ", account: "Sim101", time: 2_000, price: 5010, qty: 1, orderAction: 1 },
      { execId: "B1", symbol: "NQ", account: "Live", time: 3_000, price: 5020, qty: 1, orderAction: 0 },
      { execId: "B2", symbol: "NQ", account: "Live", time: 4_000, price: 5030, qty: 1, orderAction: 1 },
    ]);
    const trades = await new NinjaTraderSource({ dbPath, account: "Sim101" }).fetchTrades(FULL);
    expect(trades).toHaveLength(1);
    expect(trades[0].externalId).toBe("A1");
  });

  it("keeps same-symbol fills from different accounts in separate pairing streams", async () => {
    // No account option configured — both accounts come back, but must pair independently (pre-fix these merged into one qty-2 trade).
    const dbPath = buildFixture([
      { execId: "A1", symbol: "NQ", account: "Sim101", time: 1_000, price: 5000, qty: 1, orderAction: 0 },
      { execId: "B1", symbol: "NQ", account: "Live", time: 1_100, price: 5001, qty: 1, orderAction: 0 },
      { execId: "A2", symbol: "NQ", account: "Sim101", time: 1_200, price: 5005, qty: 1, orderAction: 1 },
      { execId: "B2", symbol: "NQ", account: "Live", time: 1_300, price: 5006, qty: 1, orderAction: 1 },
    ]);
    const trades = await new NinjaTraderSource({ dbPath }).fetchTrades(FULL);
    expect(trades.map((t) => [t.externalId, t.quantity, t.entryTime, t.exitTime])).toEqual([
      ["A1", 1, 1_000, 1_200],
      ["B1", 1, 1_100, 1_300],
    ]);
  });

  it("never modifies the source database file", async () => {
    const dbPath = buildFixture([
      { execId: "E1", symbol: "NQ", account: "Sim101", time: 1_000, price: 5000, qty: 1, orderAction: 0 },
    ]);
    const before = readFileSync(dbPath);
    await new NinjaTraderSource({ dbPath }).fetchTrades(FULL);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});
