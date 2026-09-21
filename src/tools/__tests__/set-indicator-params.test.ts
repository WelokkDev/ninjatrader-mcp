import { describe, it, expect } from "vitest";
import {
  createSetIndicatorParamsHandler,
  SET_INDICATOR_PARAMS_TIMEOUT_MS,
} from "../set-indicator-params.js";
import type { InboundMessage } from "../../bridge/protocol.js";
import { BridgeRequestError } from "../../bridge/connection.js";

const CAPS = ["place_order", "set_indicator_params"];

function response(overrides: Record<string, unknown> = {}): InboundMessage {
  return {
    v: 1,
    id: "r1",
    type: "set_indicator_params_response",
    found: true,
    applied: true,
    reloaded: true,
    symbol: "MNQ",
    timeframe: "5m",
    window: "MNQ 12-26  5 Minute",
    name: "NinjaTrader.NinjaScript.Indicators.SMA",
    displayName: "SMA(50)",
    indicatorId: 211,
    changed: [{ name: "Period", from: 20, to: 50 }],
    unchanged: [],
    errors: [],
    params: [{ name: "Period", label: "Period", value: 50 }],
    ...overrides,
  } as InboundMessage;
}

type SetRequest = Parameters<typeof createSetIndicatorParamsHandler>[0]["request"];

function connected(request: SetRequest, caps: string[] | null = CAPS) {
  return createSetIndicatorParamsHandler({
    isConnected: () => true,
    getAddonCaps: () => caps,
    request,
  });
}

describe("set_indicator_params handler", () => {
  it("reports disconnection without calling request", async () => {
    let called = false;
    const handler = createSetIndicatorParamsHandler({
      isConnected: () => false,
      getAddonCaps: () => CAPS,
      request: async () => {
        called = true;
        return response();
      },
    });
    const res = await handler({ symbol: "MNQ", id: 147, params: { Period: 50 } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain("not connected");
    expect(called).toBe(false);
  });

  it("fails fast when the AddOn predates the write cap", async () => {
    let called = false;
    const handler = connected(async () => {
      called = true;
      return response();
    }, ["place_order"]);
    const res = await handler({ symbol: "MNQ", id: 147, params: { Period: 50 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("recompile");
    expect(called).toBe(false);
  });

  describe("selector and params validation (nothing is sent)", () => {
    let calls = 0;
    const handler = connected(async () => {
      calls++;
      return response();
    });

    it("rejects no selector at all", async () => {
      const res = await handler({ symbol: "MNQ", params: { Period: 50 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("needs an indicator selector");
    });

    it("rejects both id and match", async () => {
      const res = await handler({
        symbol: "MNQ",
        id: 147,
        match: { name: "SMA" },
        params: { Period: 50 },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not both");
    });

    it("rejects an empty params object", async () => {
      const res = await handler({ symbol: "MNQ", id: 147, params: {} });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("at least one setting");
    });

    it("sent no request for any of the above", () => {
      expect(calls).toBe(0);
    });
  });

  it("sends id as indicatorId so it cannot clobber the correlation id", async () => {
    let seen: Record<string, unknown> | null = null;
    let seenTimeout: number | undefined;
    const handler = connected(async (_type, payload, timeoutMs) => {
      seen = payload;
      seenTimeout = timeoutMs;
      return response();
    });
    await handler({
      symbol: "MNQ",
      timeframe: "5m",
      id: 147,
      params: { Period: 50, NumStdDev: 2 },
    });
    expect(seen).toEqual({
      symbol: "MNQ",
      timeframe: "5m",
      indicatorId: 147,
      params: { Period: 50, NumStdDev: 2 },
    });
    expect(seen).not.toHaveProperty("id");
    expect(seenTimeout).toBe(SET_INDICATOR_PARAMS_TIMEOUT_MS);
  });

  it("returns the rebuilt instance's id and what changed", async () => {
    const handler = connected(async () => response());
    const res = await handler({ symbol: "MNQ", id: 147, params: { Period: 50 } });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text);
    expect(out.applied).toBe(true);
    expect(out.reloaded).toBe(true);
    expect(out.id).toBe(211);
    expect(out.changed).toEqual([{ name: "Period", from: 20, to: 50 }]);
  });

  it("keeps applied:true but flags an unconfirmed reload", async () => {
    const handler = connected(async () =>
      response({
        reloaded: false,
        reason: "the values are set and ReloadNinjaScript ran, but no rebuilt instance appeared — retry with reload:true, or press Apply in the indicator dialog",
      }),
    );
    const res = await handler({ symbol: "MNQ", id: 147, params: { Period: 50 } });
    const out = JSON.parse(res.content[0].text);
    expect(out.applied).toBe(true);
    expect(out.reloaded).toBe(false);
    expect(out.reason).toContain("reload:true");
  });

  it("reports an ambiguous selector as a refusal, not an error", async () => {
    const handler = connected(async () =>
      response({
        applied: false,
        reloaded: false,
        reason: "selector matched 2 indicators (MNQ 5m id=147, MNQ 15m id=203); pass indicatorId to name exactly one",
        changed: [],
        params: [],
      }),
    );
    const res = await handler({ symbol: "MNQ", match: { name: "SMA" }, params: { Period: 50 } });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text);
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("matched 2 indicators");
    expect(out.hint).toContain("names the gate that refused");
  });

  it("surfaces per-setting validation errors when nothing was written", async () => {
    const handler = connected(async () =>
      response({
        applied: false,
        reloaded: false,
        reason: "nothing was written: 1 of 2 requested setting(s) did not validate",
        changed: [],
        errors: [{ name: "PivotRangeType", reason: "expects one of Daily|Weekly|Monthly" }],
        params: [],
      }),
    );
    const res = await handler({
      symbol: "MNQ",
      id: 147,
      params: { Period: 50, PivotRangeType: "nope" },
    });
    const out = JSON.parse(res.content[0].text);
    expect(out.applied).toBe(false);
    expect(out.errors[0].name).toBe("PivotRangeType");
  });

  it("points a stale handle back at discovery", async () => {
    const handler = connected(async () =>
      response({
        found: false,
        applied: false,
        reloaded: false,
        reason: "no indicator on the matching chart(s) answers that selector",
        changed: [],
        params: [],
      }),
    );
    const res = await handler({ symbol: "MNQ", id: 9999, params: { Period: 50 } });
    const out = JSON.parse(res.content[0].text);
    expect(out.found).toBe(false);
    expect(out.hint).toContain("list_chart_indicators");
  });

  it("refuses a second write while the first is still in flight", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const handler = connected(() => {
      calls++;
      if (calls > 1) return Promise.resolve(response());
      return new Promise<InboundMessage>((resolve) => {
        release = () => resolve(response());
      });
    });
    const first = handler({ symbol: "MNQ", id: 147, params: { Period: 50 } });
    const second = await handler({ symbol: "MNQ", id: 147, params: { Period: 60 } });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("already running");
    release();
    expect((await first).isError).toBeFalsy();
    expect((await handler({ symbol: "MNQ", id: 147, params: { Period: 70 } })).isError).toBeFalsy();
    expect(calls).toBe(2);
  });

  it("forwards reload:true so an unconfirmed rebuild can be retried", async () => {
    let seen: Record<string, unknown> | null = null;
    const handler = connected(async (_type, payload) => {
      seen = payload;
      return response();
    });
    await handler({ symbol: "MNQ", id: 139, params: { Period: 50 }, reload: true });
    expect(seen).toMatchObject({ reload: true });
  });

  it("calls a sent-but-unanswered request ambiguous, whatever ended it", async () => {
    for (const kind of ["timeout", "disconnected"] as const) {
      const handler = connected(async () => {
        throw new BridgeRequestError(`request ${kind}`, kind, true);
      });
      const res = await handler({ symbol: "MNQ", id: 139, params: { Period: 50 } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("may or may not have landed");
    }
  });

  it("does not call a provably-unsent request ambiguous", async () => {
    const handler = connected(async () => {
      throw new BridgeRequestError("send failed", "send-failed", false);
    });
    const res = await handler({ symbol: "MNQ", id: 139, params: { Period: 50 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain("may or may not have landed");
  });
});
