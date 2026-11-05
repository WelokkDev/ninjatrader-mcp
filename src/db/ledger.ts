import type Database from "better-sqlite3";
import defaultDb from "./connection.js";

// A row of the trades table: one imported round trip.
export interface Trade {
  tradeId: string;
  source: string; // adapter id, e.g. "ninjatrader"
  externalId: string; // the source's own id; with `source`, the dedupe key
  symbol: string;
  direction: "long" | "short";
  quantity: number | null; // largest position held
  filledQuantity: number | null; // contracts traded each way
  entryTime: number; // unix seconds
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  commission: number | null;
  account: string | null;
  createdAt: number;
}

interface TradeRow {
  trade_id: string;
  source: string;
  external_id: string;
  symbol: string;
  direction: string;
  quantity: number | null;
  filled_quantity: number | null;
  entry_time: number;
  entry_price: number;
  exit_time: number | null;
  exit_price: number | null;
  commission: number | null;
  account: string | null;
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
    filledQuantity: r.filled_quantity,
    entryTime: r.entry_time,
    entryPrice: r.entry_price,
    exitTime: r.exit_time,
    exitPrice: r.exit_price,
    commission: r.commission,
    account: r.account,
    createdAt: r.created_at,
  };
}

export type ImportOutcome = "inserted" | "filled" | "unchanged" | "mismatched";

export interface Ledger {
  /** On an existing row, fills only empty columns, and only if it is still the same round trip. */
  importTrade(trade: Trade): ImportOutcome;
  getTrade(tradeId: string): Trade | undefined;
  listTrades(): Trade[];
}

function sameRoundTrip(r: TradeRow, t: Trade): boolean {
  return (
    r.symbol === t.symbol &&
    r.direction === t.direction &&
    r.entry_time === t.entryTime &&
    r.entry_price === t.entryPrice &&
    r.exit_time === t.exitTime &&
    r.exit_price === t.exitPrice
  );
}

// A factory so tests can bind an in-memory database.
export function createLedger(db: Database.Database): Ledger {
  const insertTradeStmt = db.prepare(
    `INSERT INTO trades
       (trade_id, source, external_id, symbol, direction, quantity, filled_quantity,
        entry_time, entry_price, exit_time, exit_price, commission, account, created_at)
     VALUES (@trade_id, @source, @external_id, @symbol, @direction, @quantity, @filled_quantity,
        @entry_time, @entry_price, @exit_time, @exit_price, @commission, @account, @created_at)`,
  );

  const fillGapsStmt = db.prepare(
    `UPDATE trades
        SET quantity        = COALESCE(quantity, @quantity),
            filled_quantity = COALESCE(filled_quantity, @filled_quantity),
            commission      = COALESCE(commission, @commission),
            account         = COALESCE(account, @account)
      WHERE source = @source AND external_id = @external_id`,
  );

  const findBySourceExternalIdStmt = db.prepare(
    `SELECT * FROM trades WHERE source = ? AND external_id = ? LIMIT 1`,
  );

  const getTradeStmt = db.prepare(`SELECT * FROM trades WHERE trade_id = ?`);

  const listTradesStmt = db.prepare(`SELECT * FROM trades ORDER BY entry_time ASC, rowid ASC`);

  return {
    importTrade(trade: Trade): ImportOutcome {
      const stored = findBySourceExternalIdStmt.get(trade.source, trade.externalId) as
        | TradeRow
        | undefined;
      if (stored) {
        if (!sameRoundTrip(stored, trade)) return "mismatched";
        // An UPDATE takes the write lock even when it changes nothing.
        const fillable =
          (stored.quantity === null && trade.quantity !== null) ||
          (stored.filled_quantity === null && trade.filledQuantity !== null) ||
          (stored.commission === null && trade.commission !== null) ||
          (stored.account === null && trade.account !== null);
        if (!fillable) return "unchanged";
        fillGapsStmt.run({
          source: trade.source,
          external_id: trade.externalId,
          quantity: trade.quantity,
          filled_quantity: trade.filledQuantity,
          commission: trade.commission,
          account: trade.account,
        });
        return "filled";
      }
      insertTradeStmt.run({
        trade_id: trade.tradeId,
        source: trade.source,
        external_id: trade.externalId,
        symbol: trade.symbol,
        direction: trade.direction,
        quantity: trade.quantity,
        filled_quantity: trade.filledQuantity,
        entry_time: trade.entryTime,
        entry_price: trade.entryPrice,
        exit_time: trade.exitTime,
        exit_price: trade.exitPrice,
        commission: trade.commission,
        account: trade.account,
        created_at: trade.createdAt,
      });
      return "inserted";
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
