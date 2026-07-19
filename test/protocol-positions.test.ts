import { describe, it, expect } from "vitest";
import { parseMessage } from "../src/bridge/protocol.js";

const position = {
  instrument: "MNQ 09-26",
  symbol: "MNQ",
  marketPosition: "Long",
  quantity: 2,
  averagePrice: 21000,
  pointValue: 2,
  tickSize: 0.25,
};

const order = {
  orderId: "abc",
  name: "Stop loss",
  instrument: "MNQ 09-26",
  symbol: "MNQ",
  action: "Sell",
  orderType: "StopMarket",
  state: "Working",
  quantity: 2,
  filled: 0,
  stopPrice: 20950,
};

const execution = {
  executionId: "E1",
  orderId: "abc",
  instrument: "MNQ 09-26",
  symbol: "MNQ",
  side: "Long",
  quantity: 1,
  price: 21001,
  time: 1789000000,
};

const accountSnapshot = {
  name: "Sim101",
  connection: "Sim",
  connectionStatus: "Connected",
  denomination: "UsDollar",
  realizedPnl: 125.5,
  positions: [position],
  orders: [order],
};

describe("position protocol messages", () => {
  it("parses positions_response", () => {
    const r = parseMessage(
      JSON.stringify({ v: 1, id: "1", type: "positions_response", accounts: [accountSnapshot] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "positions_response") {
      expect(r.message.accounts[0].name).toBe("Sim101");
      expect(r.message.accounts[0].positions[0].quantity).toBe(2);
      expect(r.message.accounts[0].orders[0].stopPrice).toBe(20950);
    }
  });

  it("rejects positions_response with a malformed position", () => {
    const bad = { ...accountSnapshot, positions: [{ ...position, quantity: "2" }] };
    const r = parseMessage(
      JSON.stringify({ v: 1, id: "1", type: "positions_response", accounts: [bad] }),
    );
    expect(r.ok).toBe(false);
  });

  it("parses subscribe_positions_ack and unsubscribe_positions_ack", () => {
    const sub = parseMessage(
      JSON.stringify({
        v: 1,
        id: "1",
        type: "subscribe_positions_ack",
        accounts: ["Sim101"],
        alreadyActive: false,
      }),
    );
    expect(sub.ok).toBe(true);
    const unsub = parseMessage(
      JSON.stringify({ v: 1, id: "2", type: "unsubscribe_positions_ack", removed: true }),
    );
    expect(unsub.ok).toBe(true);
  });

  it("parses position_sync with optional seq/reason/ts", () => {
    const r = parseMessage(
      JSON.stringify({
        v: 1,
        type: "position_sync",
        seq: 7,
        reason: "provider reconnect",
        ts: 1789000000,
        accounts: [accountSnapshot],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "position_sync") {
      expect(r.message.seq).toBe(7);
      expect(r.message.reason).toBe("provider reconnect");
    }
  });

  it("parses each position_event kind and enforces payload/kind match", () => {
    const base = { v: 1, type: "position_event", account: "Sim101", seq: 1, ts: 1789000000 };
    expect(
      parseMessage(
        JSON.stringify({ ...base, kind: "position", position, operation: "Add" }),
      ).ok,
    ).toBe(true);
    expect(parseMessage(JSON.stringify({ ...base, kind: "order", order })).ok).toBe(true);
    expect(
      parseMessage(JSON.stringify({ ...base, kind: "execution", execution })).ok,
    ).toBe(true);
    // kind says position but no position payload present
    expect(parseMessage(JSON.stringify({ ...base, kind: "position", order })).ok).toBe(false);
    expect(parseMessage(JSON.stringify({ ...base, kind: "nope", position })).ok).toBe(false);
  });

  it("keeps NT8 enum passthrough — unknown state strings survive", () => {
    const r = parseMessage(
      JSON.stringify({
        v: 1,
        type: "position_event",
        account: "Sim101",
        kind: "order",
        order: { ...order, state: "SomeFutureState", orderType: "TrailStop" },
      }),
    );
    expect(r.ok).toBe(true);
  });
});
