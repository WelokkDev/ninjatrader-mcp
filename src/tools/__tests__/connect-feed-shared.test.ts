import { describe, it, expect } from "vitest";
import {
  ADDON_ATTACH_WAIT_MS,
  CONNECT_FEED_REPLY_MARGIN_MS,
  connectFeedCallTimeoutMs,
  connectFeedExitCode,
  parseConnectFeedArgs,
} from "../connect-feed-shared.js";

const text = (t: string) => [{ type: "text", text: t }];

describe("parseConnectFeedArgs", () => {
  it("reads --connection and --timeout", () => {
    expect(parseConnectFeedArgs(["--connection", "My Rithmic", "--timeout", "90"])).toEqual({
      connection: "My Rithmic",
      timeoutSec: 90,
    });
  });

  it.each(["4", "181", "300", "1.5", "abc"])("refuses --timeout %s, outside what the tool accepts", (value) => {
    const res = parseConnectFeedArgs(["--timeout", value]);
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("from 5 to 180");
  });

  it("refuses unknown flags and missing values", () => {
    expect(parseConnectFeedArgs(["--wait", "5"])).toHaveProperty("error");
    expect(parseConnectFeedArgs(["--connection"])).toHaveProperty("error");
  });
});

describe("connectFeedCallTimeoutMs", () => {
  it("outlasts the tool's attach wait plus its reply margin", () => {
    expect(connectFeedCallTimeoutMs(60)).toBeGreaterThan(60_000 + ADDON_ATTACH_WAIT_MS + CONNECT_FEED_REPLY_MARGIN_MS);
  });
});

describe("connectFeedExitCode", () => {
  it("is 0 on success", () => {
    expect(connectFeedExitCode({ content: text('{"ok":true}') })).toBe(0);
  });

  it("is 1 when the tool itself reports the failure", () => {
    expect(connectFeedExitCode({ isError: true, content: text('{"ok":false,"error":"Logon failed"}') })).toBe(1);
  });

  it.each([
    ["an unknown tool, from a hub older than connect_feed", "Tool connect_feed not found"],
    ["arguments the tool's schema rejects", "Input validation error: Invalid arguments for tool connect_feed"],
  ])("is 2 for %s", (_what, message) => {
    expect(connectFeedExitCode({ isError: true, content: text(message) })).toBe(2);
  });

  it("is 2 for an error without text", () => {
    expect(connectFeedExitCode({ isError: true, content: [] })).toBe(2);
  });
});
