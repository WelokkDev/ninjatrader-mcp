import { describe, it, expect } from "vitest";
import { parseMessage } from "../protocol.js";
import { ConnectionManager } from "../connection.js";
import type { WebSocket } from "ws";

describe("parseMessage: instruments_update", () => {
  it("accepts a valid instruments_update", () => {
    const res = parseMessage(JSON.stringify({ v: 1, type: "instruments_update", instruments: ["NQ", "ES"] }));
    expect(res).toEqual({
      ok: true,
      message: { v: 1, type: "instruments_update", instruments: ["NQ", "ES"] },
    });
  });

  it("accepts an empty roster", () => {
    const res = parseMessage(JSON.stringify({ v: 1, type: "instruments_update", instruments: [] }));
    expect(res.ok).toBe(true);
  });

  it("rejects a non-string array", () => {
    const res = parseMessage(JSON.stringify({ v: 1, type: "instruments_update", instruments: [1, 2] }));
    expect(res.ok).toBe(false);
  });

  it("rejects a missing instruments field", () => {
    const res = parseMessage(JSON.stringify({ v: 1, type: "instruments_update" }));
    expect(res.ok).toBe(false);
  });
});

function fakeSocket() {
  const listeners = new Map<string, (...args: never[]) => void>();
  const sent: string[] = [];
  const socket = {
    on(event: string, cb: (...args: never[]) => void) { listeners.set(event, cb); },
    send(data: string) { sent.push(data); },
    close() {},
  } as unknown as WebSocket;
  return { socket, listeners, sent };
}

describe("ConnectionManager: instruments_update keeps the roster live", () => {
  it("replaces getStatus().instruments without touching the heartbeat clock", () => {
    const cm = new ConnectionManager();
    const { socket, listeners } = fakeSocket();
    cm.attach(socket);

    // hello sets the initial roster + heartbeat timestamp
    listeners.get("message")!(
      JSON.stringify({ v: 1, type: "hello", ntVersion: "NT8", instruments: ["ES"] }) as never,
    );
    const afterHello = cm.getStatus();
    expect(afterHello.instruments).toEqual(["ES"]);

    // a later instruments_update replaces the roster...
    listeners.get("message")!(
      JSON.stringify({ v: 1, type: "instruments_update", instruments: ["ES", "NQ"] }) as never,
    );
    const afterUpdate = cm.getStatus();
    expect(afterUpdate.instruments).toEqual(["ES", "NQ"]);
    // ...and does NOT reset the heartbeat clock (only hello/heartbeat do)
    expect(afterUpdate.lastHeartbeatAt).toBe(afterHello.lastHeartbeatAt);

    // teardown: fire the close listener so the heartbeat watchdog interval is cleared
    listeners.get("close")!(1000 as never, Buffer.from("") as never);
  });
});
