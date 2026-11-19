import { describe, it, expect, vi } from "vitest";
import { createConnectFeedHandler, type ConnectFeedDeps } from "../connect-feed.js";
import { CONNECT_FEED_REPLY_MARGIN_MS } from "../connect-feed-shared.js";
import { BridgeRequestError } from "../../bridge/index.js";
import type { ConnectFeedResponseMessage, InboundMessage } from "../../bridge/protocol.js";

const RITHMIC = "My Rithmic for NinjaTrader Brokerage";

function response(over: Partial<ConnectFeedResponseMessage> = {}): InboundMessage {
  return {
    v: 1,
    id: "r1",
    type: "connect_feed_response",
    connection: RITHMIC,
    found: true,
    ok: true,
    alreadyConnected: false,
    waitedForNt8: false,
    status: "Connected",
    priceStatus: "Connected",
    elapsedMs: 3_400,
    connections: [{ name: RITHMIC, status: "Connected", priceStatus: "Connected" }],
    ...over,
  };
}

function deps(over: Partial<ConnectFeedDeps> = {}): ConnectFeedDeps {
  return {
    isConnected: () => true,
    getAddonCaps: () => ["place_order", "connect_feed"],
    request: vi.fn(async () => response()),
    defaultConnection: () => undefined,
    attachWaitMs: 0,
    sleep: async () => {},
    ...over,
  };
}

const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

describe("connect_feed handler", () => {
  it("needs a connection name from the call or NT_FEED_CONNECTION", async () => {
    const d = deps();
    const res = await createConnectFeedHandler(d)({});
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("NT_FEED_CONNECTION");
    expect(d.request).not.toHaveBeenCalled();
  });

  it("falls back to NT_FEED_CONNECTION and sends the wait in ms", async () => {
    const d = deps({ defaultConnection: () => RITHMIC });
    const res = await createConnectFeedHandler(d)({ timeoutSec: 90 });
    expect(res.isError).toBeUndefined();
    expect(d.request).toHaveBeenCalledWith(
      "connect_feed",
      { connection: RITHMIC, timeoutMs: 90_000 },
      90_000 + CONNECT_FEED_REPLY_MARGIN_MS,
    );
  });

  it("prefers the connection passed in", async () => {
    const d = deps({ defaultConnection: () => "Other" });
    await createConnectFeedHandler(d)({ connection: ` ${RITHMIC} ` });
    expect((d.request as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ connection: RITHMIC });
  });

  it("waits for the AddOn to attach to a hub that just started", async () => {
    let polls = 0;
    const d = deps({ isConnected: () => ++polls > 3, attachWaitMs: 10_000 });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(res.isError).toBeUndefined();
    expect(d.request).toHaveBeenCalledTimes(1);
  });

  it("waits for the hello, not just the socket, before checking caps", async () => {
    let polls = 0;
    const d = deps({
      getAddonCaps: () => (++polls > 3 ? ["place_order", "connect_feed"] : undefined),
      attachWaitMs: 10_000,
    });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(res.isError).toBeUndefined();
    expect(d.request).toHaveBeenCalledTimes(1);
  });

  it("fails when the AddOn never attaches", async () => {
    const d = deps({ isConnected: () => false, attachWaitMs: 2_000 });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("did not attach within 2s");
    expect(d.request).not.toHaveBeenCalled();
  });

  it("tells an AddOn without connect_feed to recompile, without sending", async () => {
    const d = deps({ getAddonCaps: () => ["place_order", "request_ticks.v2"] });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("recompile");
    expect(d.request).not.toHaveBeenCalled();
  });

  it("reports an already-green connection", async () => {
    const d = deps({ request: vi.fn(async () => response({ alreadyConnected: true, elapsedMs: 2 })) });
    const out = parse(await createConnectFeedHandler(d)({ connection: RITHMIC }));
    expect(out).toMatchObject({ ok: true, alreadyConnected: true, status: "Connected", priceStatus: "Connected" });
    expect(out.warning).toBeUndefined();
    expect(out.waitedForNt8).toBeUndefined();
  });

  it("warns when another connection also delivers market data", async () => {
    const d = deps({
      request: vi.fn(async () =>
        response({
          connections: [
            { name: RITHMIC, status: "Connected", priceStatus: "Connected" },
            { name: "Simulated Data Feed", status: "Connected", priceStatus: "Connected" },
            { name: "Playback Connection", status: "Disconnected", priceStatus: "Disconnected" },
          ],
        }),
      ),
    });
    const out = parse(await createConnectFeedHandler(d)({ connection: RITHMIC }));
    expect(out.warning).toContain("Simulated Data Feed");
    expect(out.warning).not.toContain("Playback");
  });

  it("returns NT8's own error when the connect fails", async () => {
    const d = deps({
      request: vi.fn(async () =>
        response({
          ok: false,
          status: "Disconnected",
          priceStatus: "Disconnected",
          message: `NT8 could not connect ${RITHMIC}`,
          ntError: "LogOnFailed",
          nativeError: "Please check your account connection parameters and internet connection.",
        }),
      ),
    });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(res.isError).toBe(true);
    const out = parse(res);
    expect(out.error).toContain("NT8 error LogOnFailed");
    expect(out.error).toContain("Please check your account connection parameters");
    expect(out).toMatchObject({ ok: false, status: "Disconnected", ntError: "LogOnFailed" });
  });

  it("lists NT8's connection names when the name matches none", async () => {
    const d = deps({
      request: vi.fn(async () =>
        response({
          connection: "Rithmic",
          found: false,
          ok: false,
          status: "None",
          priceStatus: "None",
          message: "NT8 has no connection named 'Rithmic'",
          configured: [RITHMIC, "Simulated Data Feed"],
        }),
      ),
    });
    const res = await createConnectFeedHandler(d)({ connection: "Rithmic" });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toBe(`NT8 has no connection named 'Rithmic' (its connections: ${RITHMIC}, Simulated Data Feed)`);
  });

  it("says NT8 may still be connecting when the answer times out", async () => {
    const d = deps({
      request: vi.fn(async () => {
        throw new BridgeRequestError("request timed out", "timeout", true);
      }),
    });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("may still be connecting");
  });

  it("passes an AddOn rejection through", async () => {
    const d = deps({
      request: vi.fn(async () => {
        throw new BridgeRequestError("connect_feed missing required field: connection", "remote-error", true);
      }),
    });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(parse(res).error).toBe("connect_feed failed: connect_feed missing required field: connection");
  });

  it("rejects a reply of the wrong type", async () => {
    const d = deps({
      request: vi.fn(async () => ({ v: 1, id: "r1", type: "open_charts_response", charts: [], skippedWindows: 0 }) as InboundMessage),
    });
    const res = await createConnectFeedHandler(d)({ connection: RITHMIC });
    expect(parse(res).error).toContain("unexpected response type 'open_charts_response'");
  });
});
