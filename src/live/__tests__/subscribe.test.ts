import { describe, it, expect } from "vitest";
import { subscribeBars, unsubscribeBars } from "../subscribe.js";
import type { OutboundMessage } from "../../bridge/protocol.js";

describe("subscribeBars", () => {
  it("sends a subscribe_bars message carrying the instrument's trading-hours template", () => {
    const sent: OutboundMessage[] = [];
    const ok = subscribeBars("MNQ", "5m", { send: (m) => { sent.push(m); return true; } });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ v: 1, type: "subscribe_bars", symbol: "MNQ", timeframe: "5m" });
    expect((sent[0] as { tradingHoursTemplate: string }).tradingHoursTemplate.length).toBeGreaterThan(0);
  });
});

describe("unsubscribeBars", () => {
  it("sends an unsubscribe_bars message", () => {
    const sent: OutboundMessage[] = [];
    const ok = unsubscribeBars("MNQ", "5m", { send: (m) => { sent.push(m); return true; } });
    expect(ok).toBe(true);
    expect(sent[0]).toMatchObject({ v: 1, type: "unsubscribe_bars", symbol: "MNQ", timeframe: "5m" });
  });
});
