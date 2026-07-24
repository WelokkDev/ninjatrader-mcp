import { describe, expect, it } from "vitest";
import {
  parseMessage,
  type CancelAckMessage,
  type CancelAllAckMessage,
  type ChangeAckMessage,
  type FlattenAckMessage,
  type HelloMessage,
  type OcoAckMessage,
  type OrderAckMessage,
} from "../protocol.js";

// Deploy-skew rule: fields an older AddOn can't send stay optional, so both skew directions parse.

describe("hello caps", () => {
  const base = { v: 1, type: "hello", ntVersion: "NT8", instruments: ["MNQ"] };

  it("parses with caps and preserves them", () => {
    const res = parseMessage(JSON.stringify({ ...base, caps: ["place_order", "cancel_order"] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.message as HelloMessage).caps).toEqual(["place_order", "cancel_order"]);
  });

  it("parses without caps (older AddOn) and keeps the field absent", () => {
    const res = parseMessage(JSON.stringify(base));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.message as HelloMessage).caps).toBeUndefined();
  });
});

describe("order_ack effective prices", () => {
  const valid = {
    v: 1,
    id: "r1",
    type: "order_ack",
    clientOrderId: "c1",
    contract: "MNQ 09-26",
    state: "Submitted",
  };

  it("parses without prices (older AddOn)", () => {
    const res = parseMessage(JSON.stringify(valid));
    expect(res.ok).toBe(true);
  });

  it("carries effective prices when present", () => {
    const res = parseMessage(JSON.stringify({ ...valid, limitPrice: 200.25, stopPrice: 100.5 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as OrderAckMessage;
    expect(msg.limitPrice).toBe(200.25);
    expect(msg.stopPrice).toBe(100.5);
  });
});

describe("cancel_ack parsing", () => {
  const valid = {
    v: 1,
    id: "r1",
    type: "cancel_ack",
    clientOrderId: "c1",
    orderId: "O-1",
    state: "CancelSubmitted",
  };

  it("parses fully populated", () => {
    const res = parseMessage(JSON.stringify(valid));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as CancelAckMessage;
    expect(msg.state).toBe("CancelSubmitted");
    expect(msg.orderId).toBe("O-1");
  });

  it("parses without the optional orderId", () => {
    const res = parseMessage(JSON.stringify({ ...valid, orderId: undefined }));
    expect(res.ok).toBe(true);
  });

  it.each([
    ["clientOrderId", { ...valid, clientOrderId: undefined }],
    ["state", { ...valid, state: undefined }],
    ["id", { ...valid, id: undefined }],
  ])("rejects when %s is missing", (_f, payload) => {
    expect(parseMessage(JSON.stringify(payload)).ok).toBe(false);
  });
});

describe("cancel_all_ack / flatten_ack parsing", () => {
  it("cancel_all_ack parses with and without cancelledCount", () => {
    const base = { v: 1, id: "r1", type: "cancel_all_ack", contract: "MNQ 09-26" };
    const withCount = parseMessage(JSON.stringify({ ...base, cancelledCount: 2 }));
    expect(withCount.ok).toBe(true);
    if (withCount.ok) {
      expect((withCount.message as CancelAllAckMessage).cancelledCount).toBe(2);
    }
    expect(parseMessage(JSON.stringify(base)).ok).toBe(true);
  });

  it("flatten_ack parses and requires contract", () => {
    const res = parseMessage(
      JSON.stringify({ v: 1, id: "r1", type: "flatten_ack", contract: "MNQ 09-26" }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.message as FlattenAckMessage).contract).toBe("MNQ 09-26");
    expect(parseMessage(JSON.stringify({ v: 1, id: "r1", type: "flatten_ack" })).ok).toBe(false);
  });
});

describe("change_ack parsing", () => {
  const valid = {
    v: 1,
    id: "r1",
    type: "change_ack",
    clientOrderId: "c1",
    state: "ChangeSubmitted",
  };

  it("parses with effective values", () => {
    const res = parseMessage(
      JSON.stringify({ ...valid, quantity: 2, limitPrice: 200.25, stopPrice: 100.5 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as ChangeAckMessage;
    expect(msg.quantity).toBe(2);
    expect(msg.limitPrice).toBe(200.25);
  });

  it("parses with no effective values (all optional)", () => {
    expect(parseMessage(JSON.stringify(valid)).ok).toBe(true);
  });
});

describe("oco_ack parsing", () => {
  const valid = {
    v: 1,
    id: "r1",
    type: "oco_ack",
    ocoId: "base-1",
    contract: "MNQ 09-26",
    stop: { clientOrderId: "base-1:S", orderId: "O-S", state: "Submitted" },
    target: { clientOrderId: "base-1:T", state: "Submitted" },
  };

  it("parses both legs, tolerating a missing leg orderId", () => {
    const res = parseMessage(JSON.stringify(valid));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as OcoAckMessage;
    expect(msg.stop.clientOrderId).toBe("base-1:S");
    expect(msg.target.orderId).toBeUndefined();
  });

  it("carries deduped and effective prices when present", () => {
    const res = parseMessage(
      JSON.stringify({ ...valid, deduped: true, stopPrice: 100.25, limitPrice: 200.25 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as OcoAckMessage;
    expect(msg.deduped).toBe(true);
    expect(msg.stopPrice).toBe(100.25);
  });

  it.each([
    ["stop leg", { ...valid, stop: undefined }],
    ["target state", { ...valid, target: { clientOrderId: "base-1:T" } }],
    ["ocoId", { ...valid, ocoId: undefined }],
  ])("rejects when %s is missing", (_f, payload) => {
    expect(parseMessage(JSON.stringify(payload)).ok).toBe(false);
  });
});
