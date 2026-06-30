/**
 * NinjaTraderSource — SQLite reader adapter for NinjaTrader 8's local database.
 *
 * Reads executed fills from NinjaTrader.sqlite, decodes each row into a
 * RawExecution, FIFO-pairs them into round-trip RawTrades using pairExecutions,
 * stamps the source id, and range-filters the result.
 *
 * Real NT8 schema is NORMALIZED: Executions stores INTEGER foreign keys for
 * Instrument and Account (not text values). Side comes from Orders.OrderAction
 * (not MarketPosition, which records position BEFORE the fill).
 *
 * Join path:
 *   Executions.Instrument  → Instruments.Id → MasterInstruments.Id → Name (symbol)
 *   Executions.Account     → Accounts.Id → Accounts.Name
 *   Executions.OrderId     → Orders.OrderId → Orders.OrderAction (side)
 *
 * Every schema-specific fact (table names, column names, conversion helpers)
 * lives in NT_SCHEMA — the SQL is built entirely from those constants.
 *
 * Safety: fetchTrades NEVER opens the live DB read-write; it copies the file to
 * a temp directory and opens the copy read-only (openSnapshot). This is safe
 * even if NinjaTrader is running and writing concurrently.
 */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pairExecutions } from "./pair-executions.js";
import type { RawExecution, RawTrade, TradeSource } from "./types.js";

export const NT_SCHEMA = {
  tables: {
    executions:        "Executions",
    orders:            "Orders",
    instruments:       "Instruments",
    masterInstruments: "MasterInstruments",
    accounts:          "Accounts",
  },
  exec: {
    execId:      "ExecutionId",
    instrument:  "Instrument",     // INTEGER FK → Instruments.Id
    price:       "Price",
    quantity:    "Quantity",
    marketPos:   "MarketPosition", // position BEFORE fill; NOT the side (see Orders.OrderAction)
    time:        "Time",           // .NET ticks, UTC
    commission:  "Commission",
    fee:         "Fee",
    orderId:     "OrderId",        // TEXT FK → Orders.OrderId
    account:     "Account",        // INTEGER FK → Accounts.Id
  },
  orders: {
    orderId:     "OrderId",
    orderAction: "OrderAction",    // 0=Buy, 1=Sell, 2=SellShort, 3=BuyToCover
  },
  instr: {
    id:               "Id",
    masterInstrument: "MasterInstrument",
  },
  masterInstr: {
    id:   "Id",
    name: "Name",
  },
  acct: {
    id:   "Id",
    name: "Name",
  },
  
  // OrderAction enum → trade side:
  //   {0=Buy, 3=BuyToCover} → "buy"   ·   {1=Sell, 2=SellShort} → "sell"
  // Throws a named Error for any value outside {0,1,2,3} (including null/NaN).
  orderActionToSide: (a: number): "buy" | "sell" => {
    if (a === 0 || a === 3) return "buy";
    if (a === 1 || a === 2) return "sell";
    throw new Error(`NT_SCHEMA.orderActionToSide: unknown OrderAction value: ${a}`);
  },
  // .NET ticks (100ns since 0001-01-01) → unix seconds.
  // 621355968000000000 = ticks at 1970-01-01 (the Unix epoch).
  ticksToUnix: (t: number): number => Math.floor((t - 621355968000000000) / 10_000_000),
  unixToTicks: (s: number): number => s * 10_000_000 + 621355968000000000,
  commissionOf: (r: Record<string, unknown>) =>
    r["Commission"] == null ? null : Number(r["Commission"]),
};

/**
 * Creates a read-only snapshot of a SQLite database file.
 *
 * Copies the db file (and its -wal/-shm siblings if present) to a fresh temp
 * directory, then opens the copy as read-only and runs PRAGMA integrity_check.
 * The original file is never opened or written.
 *
 * The caller is responsible for closing the returned db handle and removing dir.
 * Use the `cleanup()` helper on the returned object, or close/rmSync manually.
 */
export function openSnapshot(dbPath: string): { db: Database.Database; dir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "nt-snap-"));
  const copyPath = join(tmpDir, basename(dbPath));

  copyFileSync(dbPath, copyPath);

  // Copy WAL and SHM siblings so the snapshot is consistent (if NT is in WAL mode).
  for (const suffix of ["-wal", "-shm"]) {
    const sibling = dbPath + suffix;
    if (existsSync(sibling)) {
      copyFileSync(sibling, copyPath + suffix);
    }
  }

  const db = new Database(copyPath, { readonly: true, fileMustExist: true });

  const result = db.prepare("PRAGMA integrity_check").pluck().get() as string;
  if (result !== "ok") {
    db.close();
    throw new Error(
      `NinjaTraderSource: PRAGMA integrity_check failed for "${dbPath}": ${result}`,
    );
  }

  return { db, dir: tmpDir };
}

export interface NinjaTraderSourceOptions {
  dbPath: string;
  account?: string;   // if provided, filters to this account only (matched by name)
}

export class NinjaTraderSource implements TradeSource {
  readonly id = "ninjatrader";
  readonly capabilities = {
    serverSideRange: true,   // fills are fetched in [from, to] tick range via SQL
    realizedPnl:     false,  // NT stores fills, not round-trip P&L; we derive trades
    commission:      true,
  };

  constructor(private readonly opts: NinjaTraderSourceOptions) {}

  async fetchTrades(range: { from: number; to: number }): Promise<RawTrade[]> {
    const { db, dir } = openSnapshot(this.opts.dbPath);
    try {
      const lo = NT_SCHEMA.unixToTicks(range.from);
      const hi = NT_SCHEMA.unixToTicks(range.to);

      // Aliases from NT_SCHEMA so every table/column name in the query is a constant.
      const T  = NT_SCHEMA.tables;
      const EC = NT_SCHEMA.exec;
      const OR = NT_SCHEMA.orders;
      const IN = NT_SCHEMA.instr;
      const MI = NT_SCHEMA.masterInstr;
      const AC = NT_SCHEMA.acct;

      // Four-table join to resolve symbol and account names, and to read side
      // from Orders.OrderAction. e.* is included so the full Executions row is
      // preserved in raw (audit / no-data-loss guarantee).
      const sql = [
        `SELECT`,
        `  e.${EC.execId}       AS execId,`,
        `  mi.${MI.name}        AS symbol,`,
        `  e.${EC.time}         AS time,`,
        `  e.${EC.price}        AS price,`,
        `  e.${EC.quantity}     AS quantity,`,
        `  o.${OR.orderAction}  AS orderAction,`,
        `  e.${EC.commission}   AS commission,`,
        `  a.${AC.name}         AS account,`,
        `  e.*`,
        `FROM ${T.executions} e`,
        `JOIN ${T.instruments}       i  ON i.${IN.id}  = e.${EC.instrument}`,
        `JOIN ${T.masterInstruments} mi ON mi.${MI.id} = i.${IN.masterInstrument}`,
        `LEFT JOIN ${T.orders}       o  ON o.${OR.orderId} = e.${EC.orderId}`,
        `LEFT JOIN ${T.accounts}     a  ON a.${AC.id} = e.${EC.account}`,
        `WHERE e.${EC.time} BETWEEN ? AND ?`,
        ...(this.opts.account ? [`AND a.${AC.name} = ?`] : []),
        `ORDER BY e.${EC.time} ASC, e.${EC.execId} ASC`,
      ].join("\n");

      const rows = (
        this.opts.account
          ? db.prepare(sql).all(lo, hi, this.opts.account)
          : db.prepare(sql).all(lo, hi)
      ) as Array<Record<string, unknown>>;

      const execs: RawExecution[] = rows.map((r) => ({
        externalId: String(r["execId"]),
        symbol:     String(r["symbol"]),                                    // mi.Name, already master root
        time:       NT_SCHEMA.ticksToUnix(Number(r["time"])),
        price:      Number(r["price"]),
        quantity:   Math.abs(Number(r["quantity"])),
        side:       NT_SCHEMA.orderActionToSide(Number(r["orderAction"])),  // from Orders.OrderAction
        commission: NT_SCHEMA.commissionOf(r),                              // Commission from e.*
        account:    r["account"] == null ? null : String(r["account"]),
        raw:        r,
      }));

      return pairExecutions(execs)
        .map((t) => ({ ...t, source: this.id }))
        .filter((t) => t.entryTime >= range.from && t.entryTime <= range.to);
    } finally {
      db.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}
