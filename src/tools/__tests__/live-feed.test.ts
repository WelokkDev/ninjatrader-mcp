// src/tools/__tests__/live-feed.test.ts
import { describe, it, expect } from "vitest";
import {
  createSubscribeLiveBarsHandler,
  createListLiveBarsHandler,
} from "../live-feed.js";
import type { RecordedBar, SubscriptionStatus } from "../../live/bar-recorder.js";

function parse(result: { content: Array<{ type: "text"; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("subscribe_live_bars", () => {
  it("returns an actionable error when the bridge is not connected", async () => {
    const handler = createSubscribeLiveBarsHandler({
      isConnected: () => false,
      subscribeBars: () => true,
    });
    const out = parse(await handler({ symbol: "MNQ", timeframe: "5m" }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("not connected");
  });

  it("dispatches a subscription when connected", async () => {
    let calledWith: [string, string] | null = null;
    const handler = createSubscribeLiveBarsHandler({
      isConnected: () => true,
      subscribeBars: (s, tf) => { calledWith = [s, tf]; return true; },
    });
    const out = parse(await handler({ symbol: "MNQ", timeframe: "5m" }));
    expect(out.ok).toBe(true);
    expect(calledWith).toEqual(["MNQ", "5m"]);
  });

  it("returns an error (not a throw) when the symbol is unknown", async () => {
    const handler = createSubscribeLiveBarsHandler({
      isConnected: () => true,
      subscribeBars: () => { throw new Error("unknown symbol: ZZ"); },
    });
    const out = parse(await handler({ symbol: "ZZ", timeframe: "5m" }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("ZZ");
  });
});

describe("list_live_bars", () => {
  const bar: RecordedBar = {
    receivedAtMs: 1_700_000_300_000, symbol: "MNQ", timeframe: "5m",
    timestamp: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, lagSeconds: 300,
  };
  const sub: SubscriptionStatus = {
    symbol: "MNQ", timeframe: "5m", count: 1, lastReceivedTs: 1_700_000_000, lastLagSeconds: 300, dupCount: 0,
  };

  it("returns recorded bars and active subscriptions", async () => {
    const handler = createListLiveBarsHandler({
      recorder: { recent: () => [bar], subscriptions: () => [sub] },
    });
    const out = parse(await handler({ limit: 20 }));
    expect(out.count).toBe(1);
    expect(Array.isArray(out.bars)).toBe(true);
    expect((out.activeSubscriptions as unknown[]).length).toBe(1);
  });

  it("includes a hint when nothing has been recorded yet", async () => {
    const handler = createListLiveBarsHandler({
      recorder: { recent: () => [], subscriptions: () => [] },
    });
    const out = parse(await handler({ limit: 20 }));
    expect(out.count).toBe(0);
    expect(String(out.hint)).toContain("subscribe_live_bars");
  });
});
