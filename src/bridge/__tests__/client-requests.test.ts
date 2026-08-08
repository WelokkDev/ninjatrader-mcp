import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseMessage } from "../protocol.js";
import type { InboundMessage, OutboundMessage } from "../protocol.js";
import {
  registerClientRequestHandler,
  resetClientRequestHandlers,
  startClientRequestDispatch,
  listClientRequestKinds,
} from "../client-requests.js";

function clientRequest(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: "req-1",
    type: "client_request",
    kind: "widget_lookup",
    payload: { symbol: "MNQ" },
    ...over,
  };
}

/** Captures the onMessage subscription so tests can drive it directly. */
function harness() {
  const sent: OutboundMessage[] = [];
  let deliver: ((m: InboundMessage) => void) | null = null;
  startClientRequestDispatch({
    onMessage: (_type, handler) => {
      deliver = handler as (m: InboundMessage) => void;
    },
    send: (m) => {
      sent.push(m);
      return true;
    },
  });
  if (!deliver) throw new Error("dispatch never subscribed");
  return {
    sent,
    fire: (raw: Record<string, unknown>) => {
      const r = parseMessage(JSON.stringify(raw));
      if (!r.ok) throw new Error(`test message did not parse: ${r.reason}`);
      deliver!(r.message as InboundMessage);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("client_request / client_response protocol", () => {
  it("parses a well-formed client_request", () => {
    const r = parseMessage(JSON.stringify(clientRequest()));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "client_request") {
      expect(r.message.kind).toBe("widget_lookup");
      expect(r.message.payload).toEqual({ symbol: "MNQ" });
      expect(r.message.id).toBe("req-1");
    } else {
      throw new Error("wrong type");
    }
  });

  it("defaults a missing payload to an empty bag", () => {
    const { payload: _drop, ...noPayload } = clientRequest();
    const r = parseMessage(JSON.stringify(noPayload));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "client_request") {
      expect(r.message.payload).toEqual({});
    }
  });

  it("rejects a request with no kind", () => {
    const r = parseMessage(JSON.stringify(clientRequest({ kind: "" })));
    expect(r.ok).toBe(false);
  });

  it("rejects a request with no correlation id", () => {
    const { id: _drop, ...noId } = clientRequest();
    const r = parseMessage(JSON.stringify(noId));
    expect(r.ok).toBe(false);
  });
});

describe("client request dispatch", () => {
  beforeEach(() => resetClientRequestHandlers());

  it("routes to the handler registered for the kind and echoes the id", async () => {
    const handler = vi.fn().mockResolvedValue({ items: [1, 2, 3] });
    registerClientRequestHandler("widget_lookup", handler);
    const h = harness();

    h.fire(clientRequest());
    await flush();

    expect(handler).toHaveBeenCalledWith({ symbol: "MNQ" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: "client_response",
      id: "req-1",
      kind: "widget_lookup",
      ok: true,
      payload: { items: [1, 2, 3] },
    });
  });

  it("answers ok:false for a kind nobody registered, rather than going silent", async () => {
    const h = harness();

    h.fire(clientRequest({ kind: "nope" }));
    await flush();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: "client_response", ok: false, kind: "nope" });
    expect((h.sent[0] as { error?: string }).error).toMatch(/no handler/i);
  });

  it("turns a handler rejection into ok:false carrying the message", async () => {
    registerClientRequestHandler("widget_lookup", async () => {
      throw new Error("cache is on fire");
    });
    const h = harness();

    h.fire(clientRequest());
    await flush();

    expect(h.sent[0]).toMatchObject({ ok: false, kind: "widget_lookup" });
    expect((h.sent[0] as { error?: string }).error).toContain("cache is on fire");
  });

  it("turns a synchronous handler throw into ok:false too", async () => {
    registerClientRequestHandler("widget_lookup", () => {
      throw new Error("bad args");
    });
    const h = harness();

    h.fire(clientRequest());
    await flush();

    expect(h.sent[0]).toMatchObject({ ok: false });
    expect((h.sent[0] as { error?: string }).error).toContain("bad args");
  });

  it("keeps concurrent requests correlated to their own ids", async () => {
    const resolvers: Array<(v: Record<string, unknown>) => void> = [];
    registerClientRequestHandler(
      "widget_lookup",
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const h = harness();

    h.fire(clientRequest({ id: "a" }));
    h.fire(clientRequest({ id: "b" }));
    await flush();
    // Resolve out of order: b first.
    resolvers[1]({ tag: "b" });
    resolvers[0]({ tag: "a" });
    await flush();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ id: "b", payload: { tag: "b" } });
    expect(h.sent[1]).toMatchObject({ id: "a", payload: { tag: "a" } });
  });

  it("replaces the handler when a kind is registered twice", async () => {
    registerClientRequestHandler("widget_lookup", async () => ({ v: "first" }));
    registerClientRequestHandler("widget_lookup", async () => ({ v: "second" }));
    const h = harness();

    h.fire(clientRequest());
    await flush();

    expect(h.sent[0]).toMatchObject({ payload: { v: "second" } });
  });

  it("reports the registered kinds for diagnostics", () => {
    registerClientRequestHandler("widget_lookup", async () => ({}));
    registerClientRequestHandler("widget_roster", async () => ({}));
    expect(listClientRequestKinds().sort()).toEqual(["widget_lookup", "widget_roster"]);
  });
});
