import { describe, it, expect } from "vitest";
import type { WebSocket } from "ws";
import { capsError, PRE_CAPS_ADDON_CAPS } from "../caps.js";
import { ConnectionManager } from "../connection.js";

describe("capsError", () => {
  it("passes an op the AddOn advertises", () => {
    expect(capsError("place_oco", ["place_order", "place_oco"])).toBeNull();
  });

  it("names the fix for an op it does not", () => {
    const msg = capsError("set_indicator_params", ["place_order"]);
    expect(msg).toContain("does not support set_indicator_params");
    expect(msg).toContain("recompile");
  });

  it("treats absent caps as the pre-caps AddOn, not as a wildcard", () => {
    expect(capsError("place_order", null)).toBeNull();
    expect(capsError("flatten", null)).not.toBeNull();
    expect(PRE_CAPS_ADDON_CAPS).toEqual(["place_order"]);
  });

  it("asks for a retry, not a recompile, before the hello arrives", () => {
    const msg = capsError("flatten", undefined);
    expect(msg).toContain("again in a moment");
    expect(msg).not.toContain("recompile");
  });
});

describe("ConnectionManager.getCaps", () => {
  it("is undefined between the socket attaching and the hello", () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const socket = {
      on(event: string, cb: (...args: never[]) => void) { listeners.set(event, cb); },
      send() {},
      close() {},
    } as unknown as WebSocket;
    const cm = new ConnectionManager();
    expect(cm.getCaps()).toBeNull();

    cm.attach(socket);
    expect(cm.isConnected()).toBe(true);
    expect(cm.getCaps()).toBeUndefined();

    listeners.get("message")!(
      JSON.stringify({ v: 1, type: "hello", ntVersion: "NT8", instruments: [], caps: ["connect_feed"] }) as never,
    );
    expect(cm.getCaps()).toEqual(["connect_feed"]);

    listeners.get("close")!(1000 as never, Buffer.from("") as never);
    expect(cm.getCaps()).toBeNull();
  });

  it("is null after a hello without caps, from an AddOn that predates them", () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const socket = {
      on(event: string, cb: (...args: never[]) => void) { listeners.set(event, cb); },
      send() {},
      close() {},
    } as unknown as WebSocket;
    const cm = new ConnectionManager();
    cm.attach(socket);
    listeners.get("message")!(JSON.stringify({ v: 1, type: "hello", ntVersion: "NT8", instruments: [] }) as never);
    expect(cm.getCaps()).toBeNull();
    listeners.get("close")!(1000 as never, Buffer.from("") as never);
  });
});
