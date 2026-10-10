import type Database from "better-sqlite3";
import defaultDb from "./connection.js";

// A row of the trades table: one imported round trip.
export interface Trade {
  tradeId: string;
  source: string; // adapter id, e.g. "ninjatrader"
  externalId: string; // the source's own id; with `source`, the dedupe key
  symbol: string;
  direction: "long" | "short";
  quantity: number | null; // null only on rows that predate the column
  entryTime: number; // unix seconds
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  commission: number | null;
  createdAt: number;
}

interface TradeRow {
  trade_id: string;
  source: string;
  external_id: string;
  symbol: string;
  direction: string;
  quantity: number | null;
  entry_time: number;
  entry_price: number;
  exit_time: number | null;
  exit_price: number | null;
  commission: number | null;
  created_at: number;
}

function rowToTrade(r: TradeRow): Trade {
  return {
    tradeId: r.trade_id,
    source: r.source,
    externalId: r.external_id,
    symbol: r.symbol,
    direction: r.direction as Trade["direction"],
    quantity: r.quantity,
    entryTime: r.entry_time,
    entryPrice: r.entry_price,
    exitTime: r.exit_time,
    exitPrice: r.exit_price,
    commission: r.commission,
    createdAt: r.created_at,
  };
}

export interface Ledger {
  /** No-op when a row with the same source + externalId exists; never updates one. */
  insertTradeIfAbsent(trade: Trade): void;
  getTrade(tradeId: string): Trade | undefined;
  listTrades(): Trade[];
}

// A factory so tests can bind an in-memory database.
export function createLedger(db: Database.Database): Ledger {
  const insertTradeStmt = db.prepare(
    `INSERT INTO trades
       (trade_id, source, external_id, symbol, direction, quantity, entry_time,
        entry_price, exit_time, exit_price, commission, created_at)
     VALUES (@trade_id, @source, @external_id, @symbol, @direction, @quantity, @entry_time,
        @entry_price, @exit_time, @exit_price, @commission, @created_at)`,
  );

  const findBySourceExternalIdStmt = db.prepare(
    `SELECT 1 FROM trades WHERE source = ? AND external_id = ? LIMIT 1`,
  );

  const getTradeStmt = db.prepare(`SELECT * FROM trades WHERE trade_id = ?`);

  const listTradesStmt = db.prepare(`SELECT * FROM trades ORDER BY entry_time ASC`);

  return {
    insertTradeIfAbsent(trade: Trade): void {
      if (findBySourceExternalIdStmt.get(trade.source, trade.externalId)) return;
      insertTradeStmt.run({
        trade_id: trade.tradeId,
        source: trade.source,
        external_id: trade.externalId,
        symbol: trade.symbol,
        direction: trade.direction,
        quantity: trade.quantity,
        entry_time: trade.entryTime,
        entry_price: trade.entryPrice,
        exit_time: trade.exitTime,
        exit_price: trade.exitPrice,
        commission: trade.commission,
        created_at: trade.createdAt,
      });
    },

    getTrade(tradeId: string): Trade | undefined {
      const row = getTradeStmt.get(tradeId) as TradeRow | undefined;
      return row ? rowToTrade(row) : undefined;
    },

    listTrades(): Trade[] {
      return (listTradesStmt.all() as TradeRow[]).map(rowToTrade);
    },
  };
}

// App-wide singleton bound to the shared candles.db connection.
export const ledger = createLedger(defaultDb);
