import { describe, expect, it } from "vitest";
import {
  encode,
  parseMessage,
  type BarCloseMessage,
  type HelloMessage,
  type SubscribeAckMessage,
  type SubscribeBarsMessage,
  type UnsubscribeAckMessage,
  type UnsubscribeBarsMessage,
} from "../protocol.js";

const CANDLE = {
  timestamp: 1789000200,
  open: 20000.25,
  high: 20010.5,
  low: 19995.75,
  close: 20005.0,
  volume: 1234,
};

describe("subscribe_ack parsing", () => {
  const valid = {
    v: 1,
    id: "abc-123",
    type: "subscribe_ack",
    symbol: "MNQ",
    timeframe: "5m",
    contract: "MNQ 09-26",
    seedCount: 30,
    seedLastTs: 1789000200,
    alreadyActive: false,
  };

  it("parses a fully-populated ack", () => {
    const res = parseMessage(JSON.stringify(valid));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as SubscribeAckMessage;
    expect(msg.type).toBe("subscribe_ack");
    expect(msg.id).toBe("abc-123");
    expect(msg.contract).toBe("MNQ 09-26");
    expect(msg.seedCount).toBe(30);
    expect(msg.seedLastTs).toBe(1789000200);
    expect(msg.alreadyActive).toBe(false);
  });

  it.each([
    ["id", { ...valid, id: undefined }],
    ["contract", { ...valid, contract: undefined }],
    ["seedCount", { ...valid, seedCount: "30" }],
    ["alreadyActive", { ...valid, alreadyActive: undefined }],
  ])("rejects when %s is missing/mistyped", (_field, payload) => {
    const res = parseMessage(JSON.stringify(payload));
    expect(res.ok).toBe(false);
  });
});

describe("unsubscribe_ack parsing", () => {
  const valid = {
    v: 1,
    id: "u-1",
    type: "unsubscribe_ack",
    symbol: "MNQ",
    timeframe: "5m",
    removed: true,
  };

  it("parses a valid ack", () => {
    const res = parseMessage(JSON.stringify(valid));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as UnsubscribeAckMessage;
    expect(msg.type).toBe("unsubscribe_ack");
    expect(msg.removed).toBe(true);
  });

  it("rejects a missing removed flag (no silent default)", () => {
    const res = parseMessage(JSON.stringify({ ...valid, removed: undefined }));
    expect(res.ok).toBe(false);
  });
});

describe("bar_close optional live fields", () => {
  const base = {
    v: 1,
    type: "bar_close",
    symbol: "MNQ",
    timeframe: "5m",
    candle: CANDLE,
  };

  it("still parses a legacy bar_close without seq/contract/backfill", () => {
    const res = parseMessage(JSON.stringify(base));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as BarCloseMessage;
    expect(msg.seq).toBeUndefined();
    expect(msg.contract).toBeUndefined();
    expect(msg.backfill).toBeUndefined();
  });

  it("carries seq/contract/backfill through when present", () => {
    const res = parseMessage(
      JSON.stringify({ ...base, seq: 7, contract: "MNQ 09-26", backfill: true }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = res.message as BarCloseMessage;
    expect(msg.seq).toBe(7);
    expect(msg.contract).toBe("MNQ 09-26");
    expect(msg.backfill).toBe(true);
  });

  it("rejects a string seq", () => {
    const res = parseMessage(JSON.stringify({ ...base, seq: "7" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("seq");
  });
});

describe("hello optional timeZone", () => {
  const base = { v: 1, type: "hello", ntVersion: "NT8", instruments: ["MNQ"] };

  it("carries timeZone through when present", () => {
    const res = parseMessage(
      JSON.stringify({ ...base, timeZone: "Eastern Standard Time" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.message as HelloMessage).timeZone).toBe("Eastern Standard Time");
  });

  it("leaves timeZone absent when not sent", () => {
    const res = parseMessage(JSON.stringify(base));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.message as HelloMessage).timeZone).toBeUndefined();
  });
});

describe("outbound subscribe messages encode", () => {
  it("round-trips subscribe_bars", () => {
    const msg: SubscribeBarsMessage = {
      v: 1,
      id: "s-1",
      type: "subscribe_bars",
      symbol: "MNQ",
      timeframe: "5m",
      tradingHoursTemplate: "cme_us_index_futures_eth",
    };
    const decoded = JSON.parse(encode(msg));
    expect(decoded.type).toBe("subscribe_bars");
    expect(decoded.id).toBe("s-1");
    expect(decoded.tradingHoursTemplate).toBe("cme_us_index_futures_eth");
  });

  it("round-trips unsubscribe_bars", () => {
    const msg: UnsubscribeBarsMessage = {
      v: 1,
      id: "u-2",
      type: "unsubscribe_bars",
      symbol: "MNQ",
      timeframe: "5m",
    };
    const decoded = JSON.parse(encode(msg));
    expect(decoded.type).toBe("unsubscribe_bars");
    expect(decoded.symbol).toBe("MNQ");
  });
});
