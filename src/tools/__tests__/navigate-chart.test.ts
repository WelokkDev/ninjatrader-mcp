import { describe, it, expect } from "vitest";
import { createNavigateChartHandler } from "../navigate-chart.js";
import { parseMessage } from "../../bridge/protocol.js";
import type { InboundMessage } from "../../bridge/protocol.js";
import { formatExchangeTime } from "../../core/time.js";

// 2026-06-12 09:00:00 ET
const TARGET_TS = 1781269200;

const okResult = {
  window: "Chart",
  symbol: "MNQ",
  timeframe: "5m",
  ok: true,
  method: "slot",
  visibleFromTs: TARGET_TS - 9000,
  visibleToTs: TARGET_TS + 9000,
  activated: true,
};

function ack(
  overrides: Partial<{ results: unknown[]; matched: number; skippedWindows: number }> = {},
): InboundMessage {
  return {
    v: 1,
    id: "r1",
    type: "navigate_chart_ack",
    results: [okResult],
    matched: 1,
    skippedWindows: 0,
    ...overrides,
  } as InboundMessage;
}

describe("navigate_chart handler", () => {
  it("reports disconnection without calling request", async () => {
    let called = false;
    const handler = createNavigateChartHandler({
      isConnected: () => false,
      request: async () => {
        called = true;
        return ack();
      },
    });
    const res = await handler({ symbol: "MNQ", ts: TARGET_TS });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain("not connected");
    expect(called).toBe(false);
  });

  it("rejects a call with neither ts nor barsOnScreen", async () => {
    let called = false;
    const handler = createNavigateChartHandler({
      isConnected: () => true,
      request: async () => {
        called = true;
        return ack();
      },
    });
    const res = await handler({ symbol: "MNQ" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("nothing to do");
    expect(called).toBe(false);
  });

  it("sends only the provided fields and returns the ack with ET renderings", async () => {
    let sent: Record<string, unknown> | undefined;
    const handler = createNavigateChartHandler({
      isConnected: () => true,
      request: async (_type, payload) => {
        sent = payload;
        return ack();
      },
    });
    const res = await handler({ symbol: "MNQ", ts: TARGET_TS, align: "right" });
    expect(sent).toEqual({ symbol: "MNQ", ts: TARGET_TS, align: "right" });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.matched).toBe(1);
    expect(parsed.results[0].ok).toBe(true);
    expect(parsed.results[0].visibleFrom).toBe(formatExchangeTime(okResult.visibleFromTs));
    expect(parsed.results[0].visibleTo).toBe(formatExchangeTime(okResult.visibleToTs));
  });

  it("passes zoom-only calls through", async () => {
    let sent: Record<string, unknown> | undefined;
    const handler = createNavigateChartHandler({
      isConnected: () => true,
      request: async (_type, payload) => {
        sent = payload;
        return ack({ results: [{ ...okResult, method: undefined }] });
      },
    });
    const res = await handler({ symbol: "MNQ", barsOnScreen: 120, timeframe: "5m" });
    expect(sent).toEqual({ symbol: "MNQ", barsOnScreen: 120, timeframe: "5m" });
    expect(res.isError).toBeUndefined();
  });

  it("surfaces clamped results with the loaded-range hint fields", async () => {
    const handler = createNavigateChartHandler({
      isConnected: () => true,
      request: async () =>
        ack({
          results: [
            { ...okResult, clamped: true, firstLoadedTs: TARGET_TS + 86400, lastLoadedTs: TARGET_TS + 864000 },
          ],
        }),
    });
    const parsed = JSON.parse((await handler({ symbol: "MNQ", ts: TARGET_TS })).content[0].text);
    expect(parsed.results[0].clamped).toBe(true);
    expect(parsed.results[0].firstLoaded).toBe(formatExchangeTime(TARGET_TS + 86400));
  });

  it("surfaces skippedWindows when non-zero and omits it otherwise", async () => {
    const busy = createNavigateChartHandler({
      isConnected: () => true,
      request: async () => ack({ skippedWindows: 2 }),
    });
    expect(JSON.parse((await busy({ symbol: "MNQ", ts: TARGET_TS })).content[0].text).skippedWindows).toBe(2);

    const clean = createNavigateChartHandler({
      isConnected: () => true,
      request: async () => ack(),
    });
    expect(
      JSON.parse((await clean({ symbol: "MNQ", ts: TARGET_TS })).content[0].text).skippedWindows,
    ).toBeUndefined();
  });

  it("rewrites a timeout into the stale-addon hint", async () => {
    const handler = createNavigateChartHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("Request navigate_chart (x) timed out after 5000ms");
      },
    });
    const text = (await handler({ symbol: "MNQ", ts: TARGET_TS })).content[0].text;
    expect(text).toContain("recompile");
  });

  it("passes through a bridge error message", async () => {
    const handler = createNavigateChartHandler({
      isConnected: () => true,
      request: async () => {
        throw new Error("no open chart matches symbol=ES — call list_open_charts to see what's open");
      },
    });
    expect((await handler({ symbol: "ES", ts: TARGET_TS })).content[0].text).toContain(
      "no open chart matches",
    );
  });

  it("rejects an unexpected response type", async () => {
    const handler = createNavigateChartHandler({
      isConnected: () => true,
      request: async () => ({ v: 1, type: "heartbeat" }) as InboundMessage,
    });
    expect((await handler({ symbol: "MNQ", ts: TARGET_TS })).content[0].text).toContain(
      "unexpected response type",
    );
  });
});

describe("navigate_chart_ack protocol registration", () => {
  it("parseMessage accepts a well-formed ack", () => {
    const parsed = parseMessage(
      JSON.stringify({ v: 1, id: "n1", type: "navigate_chart_ack", results: [okResult], matched: 1 }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message.type).toBe("navigate_chart_ack");
    }
  });

  it("parseMessage rejects an ack missing results", () => {
    const parsed = parseMessage(
      JSON.stringify({ v: 1, id: "n1", type: "navigate_chart_ack", matched: 0 }),
    );
    expect(parsed.ok).toBe(false);
  });
});
