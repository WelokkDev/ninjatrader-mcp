import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createOrderAudit, type OrderAudit, type OrderOpEntry } from "../audit.js";

function opEntry(over: Partial<OrderOpEntry> = {}): OrderOpEntry {
  return {
    ts: 1_789_000_000,
    op: "cancel",
    source: "test",
    account: "Sim101",
    symbol: null,
    clientOrderId: "coid-1",
    quantity: null,
    limitPrice: null,
    stopPrice: null,
    decision: "dispatched",
    denyReason: null,
    state: "CancelSubmitted",
    error: null,
    reason: null,
    ...over,
  };
}

describe("order audit DAO", () => {
  let audit: OrderAudit;
  beforeEach(() => {
    const db = new Database(":memory:");
    initializeSchema(db);
    audit = createOrderAudit(db);
  });

  it("order_ops rows round-trip, newest first", () => {
    audit.recordOp(opEntry());
    audit.recordOp(
      opEntry({
        ts: 1_789_000_100,
        op: "change",
        clientOrderId: "coid-2",
        quantity: 2,
        limitPrice: 200.25,
        decision: "blocked",
        denyReason: "qty-exceeds-max",
        state: null,
        error: "quantity 2 exceeds AddOn maxQty 1",
        reason: "trail",
      }),
    );
    const ops = audit.recentOps();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual(
      opEntry({
        ts: 1_789_000_100,
        op: "change",
        clientOrderId: "coid-2",
        quantity: 2,
        limitPrice: 200.25,
        decision: "blocked",
        denyReason: "qty-exceeds-max",
        state: null,
        error: "quantity 2 exceeds AddOn maxQty 1",
        reason: "trail",
      }),
    );
    expect(ops[1]).toEqual(opEntry());
  });

  it("order_ops accepts instrument-wide ops (null clientOrderId, symbol set)", () => {
    audit.recordOp(opEntry({ op: "flatten", clientOrderId: null, symbol: "MNQ", state: null }));
    expect(audit.recentOps()[0]).toMatchObject({ op: "flatten", symbol: "MNQ", clientOrderId: null });
  });

  it("order_submissions rows carry oco_group and read it back", () => {
    const leg = {
      ts: 1_789_000_000,
      source: "test",
      account: "Sim101",
      symbol: "MNQ",
      action: "Sell",
      quantity: 1,
      tif: "Gtc",
      decision: "submitted" as const,
      denyReason: null,
      contract: "MNQ 09-26",
      orderId: null,
      state: "Submitted",
      error: null,
      reason: null,
      ocoGroup: "base-1",
    };
    audit.record({ ...leg, clientOrderId: "base-1:S", orderType: "Stop", limitPrice: null, stopPrice: 100 });
    audit.record({ ...leg, clientOrderId: "base-1:T", orderType: "Limit", limitPrice: 200, stopPrice: null });
    const rows = audit.recent();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ocoGroup === "base-1")).toBe(true);
  });

  it("order_submissions ocoGroup defaults to null when omitted", () => {
    audit.record({
      ts: 1,
      source: "test",
      clientOrderId: "a",
      account: "Sim101",
      symbol: "MNQ",
      action: "Buy",
      orderType: "Market",
      quantity: 1,
      limitPrice: null,
      stopPrice: null,
      tif: "Day",
      decision: "submitted",
      denyReason: null,
      contract: null,
      orderId: null,
      state: null,
      error: null,
      reason: null,
    });
    expect(audit.recent()[0].ocoGroup).toBeNull();
  });
});
