import type Database from "better-sqlite3";
import defaultDb from "../db/connection.js";

// Append-only DAO over write-path attempts. Factory-built so tests bind a
// :memory: db; the module singleton binds the shared candles.db connection.

export type OrderDecision = "submitted" | "blocked" | "failed";
export type OrderOpKind = "cancel" | "cancel-all" | "flatten" | "change";
export type OrderOpDecision = "dispatched" | "blocked" | "failed";

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
  /** Shared id linking OCO leg rows; null for single orders. */
  ocoGroup?: string | null;
}

/** One non-placement write attempt (cancel / cancel-all / flatten / change). */
export interface OrderOpEntry {
  ts: number; // unix seconds
  op: OrderOpKind;
  source: string;
  account: string;
  /** cancel-all / flatten only. */
  symbol: string | null;
  /** The TARGET order (cancel / change); null for instrument-wide ops. */
  clientOrderId: string | null;
  quantity: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  decision: OrderOpDecision;
  denyReason: string | null;
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
  oco_group: string | null;
}

interface OrderOpRow {
  ts: number;
  op: string;
  source: string;
  account: string;
  symbol: string | null;
  client_order_id: string | null;
  quantity: number | null;
  limit_price: number | null;
  stop_price: number | null;
  decision: string;
  deny_reason: string | null;
  state: string | null;
  error: string | null;
  reason: string | null;
}

export interface OrderAudit {
  record(entry: OrderAuditEntry): void;
  recent(limit?: number): OrderAuditEntry[];
  recordOp(entry: OrderOpEntry): void;
  recentOps(limit?: number): OrderOpEntry[];
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
    ocoGroup: r.oco_group,
  };
}

function rowToOpEntry(r: OrderOpRow): OrderOpEntry {
  return {
    ts: r.ts,
    op: r.op as OrderOpKind,
    source: r.source,
    account: r.account,
    symbol: r.symbol,
    clientOrderId: r.client_order_id,
    quantity: r.quantity,
    limitPrice: r.limit_price,
    stopPrice: r.stop_price,
    decision: r.decision as OrderOpDecision,
    denyReason: r.deny_reason,
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
        contract, order_id, state, error, reason, oco_group)
     VALUES
       (@ts, @source, @client_order_id, @account, @symbol, @action, @order_type,
        @quantity, @limit_price, @stop_price, @tif, @decision, @deny_reason,
        @contract, @order_id, @state, @error, @reason, @oco_group)`,
  );

  const recentStmt = db.prepare(
    `SELECT * FROM order_submissions ORDER BY id DESC LIMIT ?`,
  );

  const insertOpStmt = db.prepare(
    `INSERT INTO order_ops
       (ts, op, source, account, symbol, client_order_id, quantity,
        limit_price, stop_price, decision, deny_reason, state, error, reason)
     VALUES
       (@ts, @op, @source, @account, @symbol, @client_order_id, @quantity,
        @limit_price, @stop_price, @decision, @deny_reason, @state, @error, @reason)`,
  );

  const recentOpsStmt = db.prepare(
    `SELECT * FROM order_ops ORDER BY id DESC LIMIT ?`,
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
        oco_group: entry.ocoGroup ?? null,
      });
    },

    recent(limit = 50): OrderAuditEntry[] {
      const rows = recentStmt.all(limit) as OrderAuditRow[];
      return rows.map(rowToEntry);
    },

    recordOp(entry: OrderOpEntry): void {
      insertOpStmt.run({
        ts: entry.ts,
        op: entry.op,
        source: entry.source,
        account: entry.account,
        symbol: entry.symbol,
        client_order_id: entry.clientOrderId,
        quantity: entry.quantity,
        limit_price: entry.limitPrice,
        stop_price: entry.stopPrice,
        decision: entry.decision,
        deny_reason: entry.denyReason,
        state: entry.state,
        error: entry.error,
        reason: entry.reason,
      });
    },

    recentOps(limit = 50): OrderOpEntry[] {
      const rows = recentOpsStmt.all(limit) as OrderOpRow[];
      return rows.map(rowToOpEntry);
    },
  };
}

export const orderAudit = createOrderAudit(defaultDb);
