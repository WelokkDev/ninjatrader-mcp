import { describe, it, expect } from "vitest";
import { parseMessage, encode } from "../src/bridge/protocol.js";

describe("parseMessage", () => {
  it("parses a valid hello", () => {
    const raw = JSON.stringify({
      v: 1,
      type: "hello",
      ntVersion: "NT8",
      instruments: ["NQ", "ES"],
    });
    const r = parseMessage(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toEqual({
        v: 1,
        type: "hello",
        ntVersion: "NT8",
        instruments: ["NQ", "ES"],
      });
    }
  });

  it("parses a heartbeat", () => {
    const r = parseMessage(JSON.stringify({ v: 1, type: "heartbeat" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.type).toBe("heartbeat");
  });

  it("parses candles_response with valid payload", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "req-123",
      type: "candles_response",
      symbol: "NQ",
      timeframe: "15m",
      candles: [
        {
          timestamp: 1700000000,
          open: 100,
          high: 110,
          low: 95,
          close: 105,
          volume: 1000,
        },
      ],
    });
    const r = parseMessage(raw);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "candles_response") {
      expect(r.message.id).toBe("req-123");
      expect(r.message.candles).toHaveLength(1);
    }
  });

  it("parses bar_close", () => {
    const raw = JSON.stringify({
      v: 1,
      type: "bar_close",
      symbol: "NQ",
      timeframe: "15m",
      candle: {
        timestamp: 1700000000,
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 1000,
      },
    });
    const r = parseMessage(raw);
    expect(r.ok).toBe(true);
  });

  it("parses an error message", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "req-123",
      type: "error",
      message: "boom",
    });
    const r = parseMessage(raw);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "error") {
      expect(r.message.message).toBe("boom");
    }
  });

  it("rejects invalid JSON", () => {
    const r = parseMessage("not-json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/JSON/i);
  });

  it("rejects wrong protocol version", () => {
    const r = parseMessage(JSON.stringify({ v: 2, type: "heartbeat" }));
    expect(r.ok).toBe(false);
  });

  it("rejects unknown type", () => {
    const r = parseMessage(JSON.stringify({ v: 1, type: "wat" }));
    expect(r.ok).toBe(false);
  });

  it("rejects candles_response missing id", () => {
    const r = parseMessage(
      JSON.stringify({
        v: 1,
        type: "candles_response",
        symbol: "NQ",
        timeframe: "15m",
        candles: [],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects candles_response with malformed candle", () => {
    const r = parseMessage(
      JSON.stringify({
        v: 1,
        id: "x",
        type: "candles_response",
        symbol: "NQ",
        timeframe: "15m",
        candles: [{ timestamp: "not-a-number" }],
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("encode", () => {
  it("round-trips a draw_zone with optional timestamps", () => {
    const json = encode({
      v: 1,
      type: "draw_zone",
      id: "z1",
      symbol: "NQ",
      proximal: 20100,
      distal: 20050,
      fromTs: 1700000000,
      toTs: 1700100000,
    });
    const obj = JSON.parse(json);
    expect(obj.fromTs).toBe(1700000000);
    expect(obj.toTs).toBe(1700100000);
    expect(obj.id).toBe("z1");
  });

  it("round-trips a clear_zones with ids array", () => {
    const json = encode({
      v: 1,
      type: "clear_zones",
      symbol: "NQ",
      ids: ["a", "b", "c"],
    });
    const obj = JSON.parse(json);
    expect(obj.ids).toEqual(["a", "b", "c"]);
  });
});
