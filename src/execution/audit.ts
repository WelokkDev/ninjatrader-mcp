import type Database from "better-sqlite3";
import defaultDb from "../db/connection.js";

// DAO over `order_submissions` — the append-only record of every write-path
// attempt. Factory-built (createOrderAudit(db)) so tests bind a :memory: db;
// the module singleton binds the app's shared candles.db connection.

export type OrderDecision = "submitted" | "blocked" | "failed";

export interface OrderAuditEntry {
  ts: number; // unix seconds
  source: string;
  clientOrderId: string;
  account: string;
  symbol: string;
  action: string;
  orderType: string;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  tif: string;
  decision: OrderDecision;
  denyReason: string | null;
  contract: string | null;
  orderId: string | null;
  state: string | null;
  error: string | null;
  reason: string | null;
}

interface OrderAuditRow {
  ts: number;
  source: string;
  client_order_id: string;
  account: string;
  symbol: string;
  action: string;
  order_type: string;
  quantity: number;
  limit_price: number | null;
  stop_price: number | null;
  tif: string;
  decision: string;
  deny_reason: string | null;
  contract: string | null;
  order_id: string | null;
  state: string | null;
  error: string | null;
  reason: string | null;
}

export interface OrderAudit {
  record(entry: OrderAuditEntry): void;
  recent(limit?: number): OrderAuditEntry[];
}

function rowToEntry(r: OrderAuditRow): OrderAuditEntry {
  return {
    ts: r.ts,
    source: r.source,
    clientOrderId: r.client_order_id,
    account: r.account,
    symbol: r.symbol,
    action: r.action,
    orderType: r.order_type,
    quantity: r.quantity,
    limitPrice: r.limit_price,
    stopPrice: r.stop_price,
    tif: r.tif,
    decision: r.decision as OrderDecision,
    denyReason: r.deny_reason,
    contract: r.contract,
    orderId: r.order_id,
    state: r.state,
    error: r.error,
    reason: r.reason,
  };
}

export function createOrderAudit(db: Database.Database): OrderAudit {
  const insertStmt = db.prepare(
    `INSERT INTO order_submissions
       (ts, source, client_order_id, account, symbol, action, order_type,
        quantity, limit_price, stop_price, tif, decision, deny_reason,
        contract, order_id, state, error, reason)
     VALUES
       (@ts, @source, @client_order_id, @account, @symbol, @action, @order_type,
        @quantity, @limit_price, @stop_price, @tif, @decision, @deny_reason,
        @contract, @order_id, @state, @error, @reason)`,
  );

  const recentStmt = db.prepare(
    `SELECT * FROM order_submissions ORDER BY id DESC LIMIT ?`,
  );

  return {
    record(entry: OrderAuditEntry): void {
      insertStmt.run({
        ts: entry.ts,
        source: entry.source,
        client_order_id: entry.clientOrderId,
        account: entry.account,
        symbol: entry.symbol,
        action: entry.action,
        order_type: entry.orderType,
        quantity: entry.quantity,
        limit_price: entry.limitPrice,
        stop_price: entry.stopPrice,
        tif: entry.tif,
        decision: entry.decision,
        deny_reason: entry.denyReason,
        contract: entry.contract,
        order_id: entry.orderId,
        state: entry.state,
        error: entry.error,
        reason: entry.reason,
      });
    },

    recent(limit = 50): OrderAuditEntry[] {
      const rows = recentStmt.all(limit) as OrderAuditRow[];
      return rows.map(rowToEntry);
    },
  };
}

export const orderAudit = createOrderAudit(defaultDb);
