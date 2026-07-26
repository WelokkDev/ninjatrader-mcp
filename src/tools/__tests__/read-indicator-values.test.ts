import { describe, it, expect } from "vitest";
import { createReadIndicatorValuesHandler } from "../read-indicator-values.js";
import type { InboundMessage } from "../../bridge/protocol.js";

function response(overrides: Record<string, unknown> = {}): InboundMessage {
  return {
    v: 1,
    id: "r1",
    type: "indicator_values_response",
    found: true,
    symbol: "MNQ",
    timeframe: "15s",
    window: "MNQ 09-26  15 Second",
    indicatorId: 3,
    displayName: "SMA(20)",
    matchCount: 1,
    displacement: 0,
    barCount: 2,
    barsFrom: 1_753_465_000,
    barsTo: 1_753_468_815,
    plots: [
      {
        name: "SMA",
        values: [
          { t: 1_753_468_800, v: 21050.25 },
          { t: 1_753_468_815, v: 21050.4 },
        ],
        availableFrom: 1_753_468_800,
        availableTo: 1_753_468_815,
        truncated: false,
      },
    ],
    ...overrides,
  } as InboundMessage;
}

function connected(request: ReadIndicatorValuesRequest) {
  return createReadIndicatorValuesHandler({ isConnected: () => true, request });
}
type ReadIndicatorValuesRequest = Parameters<typeof createReadIndicatorValuesHandler>[0]["request"];

describe("read_indicator_values handler", () => {
  it("reports disconnection without calling request", async () => {
    let called = false;
    const handler = createReadIndicatorValuesHandler({
      isConnected: () => false,
      request: async () => {
        called = true;
        return response();
      },
    });
    const res = await handler({ symbol: "MNQ", id: 3 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain("not connected");
    expect(called).toBe(false);
  });

  describe("selector and range validation (no request is sent)", () => {
    let calls = 0;
    const handler = connected(async () => {
      calls++;
      return response();
    });

    it("rejects no selector at all", async () => {
      const res = await handler({ symbol: "MNQ" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("needs an indicator selector");
    });

    it("rejects both id and match", async () => {
      const res = await handler({ symbol: "MNQ", id: 3, match: { name: "SMA" } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not both");
    });

    it("rejects bars combined with a from/to range", async () => {
      const res = await handler({ symbol: "MNQ", id: 3, bars: 10, from: 1_753_400_000 });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not both");
    });

    it("rejects an inverted from/to range", async () => {
      const res = await handler({ symbol: "MNQ", id: 3, from: 200, to: 100 });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("range is empty");
    });

    it("sent nothing over the bridge for any of those", () => {
      expect(calls).toBe(0);
    });
  });

  it("maps the id selector onto the wire's indicatorId, never `id`", async () => {
    let captured: { type: string; payload: Record<string, unknown> } | undefined;
    const handler = connected(async (type, payload) => {
      captured = { type, payload };
      return response();
    });
    await handler({ symbol: "MNQ", id: 3 });
    expect(captured?.type).toBe("request_indicator_values");
    // `id` in the payload would clobber the envelope's correlation uuid.
    expect(captured?.payload).toEqual({ symbol: "MNQ", indicatorId: 3, bars: 1 });
    expect(captured?.payload.id).toBeUndefined();
  });

  it("defaults to the single most recent point when no range is given", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = connected(async (_type, payload) => {
      captured = payload;
      return response();
    });
    await handler({ symbol: "MNQ", match: { name: "SMA", params: { Period: 20 } } });
    expect(captured).toEqual({
      symbol: "MNQ",
      match: { name: "SMA", params: { Period: 20 } },
      bars: 1,
    });
  });

  it("forwards a from/to range without adding a bars default", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = connected(async (_type, payload) => {
      captured = payload;
      return response();
    });
    await handler({ symbol: "MNQ", timeframe: "15s", id: 3, from: 1_753_400_000, to: 1_753_468_815 });
    expect(captured).toEqual({
      symbol: "MNQ",
      timeframe: "15s",
      indicatorId: 3,
      from: 1_753_400_000,
      to: 1_753_468_815,
    });
  });

  it("forwards an explicit bars count", async () => {
    let captured: Record<string, unknown> | undefined;
    const handler = connected(async (_type, payload) => {
      captured = payload;
      return response();
    });
    await handler({ symbol: "MNQ", id: 3, bars: 50 });
    expect(captured?.bars).toBe(50);
  });

  it("returns the plots with readable times and a point count", async () => {
    const handler = connected(async () => response());
    const parsed = JSON.parse((await handler({ symbol: "MNQ", id: 3 })).content[0].text);
    expect(parsed.found).toBe(true);
    expect(parsed.id).toBe(3); // the handle comes back as `id`, ready to re-poll
    expect(parsed.displayName).toBe("SMA(20)");
    expect(parsed.pointCount).toBe(2);
    expect(parsed.plots[0].values[0].v).toBe(21050.25);
    expect(typeof parsed.plots[0].availableFromTime).toBe("string");
    expect(typeof parsed.barsFromTime).toBe("string");
    expect(parsed.warning).toBeUndefined();
    expect(parsed.matchCount).toBeUndefined(); // a single match is not worth reporting
  });

  it("invents no time for a plot that served nothing", async () => {
    const handler = connected(async () =>
      response({
        plots: [
          { name: "SMA", values: [], availableFrom: null, availableTo: null, truncated: false },
        ],
      }),
    );
    const parsed = JSON.parse((await handler({ symbol: "MNQ", id: 3 })).content[0].text);
    expect(parsed.pointCount).toBe(0);
    expect(parsed.plots[0].availableFromTime).toBeUndefined();
    expect(parsed.plots[0].availableFrom).toBeNull();
  });

  it("warns when a plot was truncated", async () => {
    const handler = connected(async () =>
      response({
        plots: [
          {
            name: "SMA",
            values: [{ t: 1_753_468_815, v: 21050.4 }],
            availableFrom: 1_753_468_815,
            availableTo: 1_753_468_815,
            truncated: true,
          },
        ],
      }),
    );
    const parsed = JSON.parse((await handler({ symbol: "MNQ", id: 3 })).content[0].text);
    expect(parsed.warning).toContain("5000");
  });

  it("surfaces an ambiguous selector", async () => {
    const handler = connected(async () => response({ matchCount: 3 }));
    const parsed = JSON.parse(
      (await handler({ symbol: "MNQ", match: { name: "SMA" } })).content[0].text,
    );
    expect(parsed.matchCount).toBe(3);
  });

  it("treats found:false as a valid outcome, not an error", async () => {
    const handler = connected(async () =>
      response({ found: false, reason: "no open chart matches symbol=MNQ", plots: [] }),
    );
    const res = await handler({ symbol: "MNQ", id: 3 });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.found).toBe(false);
    expect(parsed.reason).toContain("no open chart");
    expect(parsed.hint).toContain("list_chart_indicators");
  });

  it("rewrites a timeout into the stale-addon hint", async () => {
    const handler = connected(async () => {
      throw new Error("Request request_indicator_values (x) timed out after 6000ms");
    });
    const text = (await handler({ symbol: "MNQ", id: 3 })).content[0].text;
    expect(text).toContain("recompile");
    expect(text).toContain("request_indicator_values");
  });

  it("passes through a bridge error message", async () => {
    const handler = connected(async () => {
      throw new Error("window enumeration failed: boom");
    });
    expect((await handler({ symbol: "MNQ", id: 3 })).content[0].text).toContain(
      "window enumeration failed: boom",
    );
  });

  it("rejects an unexpected response type", async () => {
    const handler = connected(async () => ({ v: 1, type: "heartbeat" }) as InboundMessage);
    expect((await handler({ symbol: "MNQ", id: 3 })).content[0].text).toContain(
      "unexpected response type",
    );
  });
});
