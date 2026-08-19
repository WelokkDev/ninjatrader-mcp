import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeRequestError } from "../connection.js";

// Isolates the singleton bridge to pin the onMessage wiring: an unregistered
// sync is silently dead, which is the failure mode that shipped.
vi.mock("../index.js", () => ({ onMessage: vi.fn() }));

import { onMessage } from "../index.js";
import { registerHelloSync, runHelloSync } from "../hello-sync.js";

const onMessageMock = vi.mocked(onMessage);

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  onMessageMock.mockClear();
});

describe("registerHelloSync", () => {
  it("registers on hello and runs the sync when hello fires", async () => {
    const run = vi.fn(async () => ({ synced: 1, failed: 0 }));
    registerHelloSync("test-sync", run);

    expect(onMessageMock).toHaveBeenCalledTimes(1);
    const [type, handler] = onMessageMock.mock.calls[0];
    expect(type).toBe("hello");

    expect(run).not.toHaveBeenCalled();
    (handler as () => void)();
    (handler as () => void)();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("logs a rejected run instead of letting it escape the hello handler", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    registerHelloSync("test-sync", async () => {
      throw new Error("sync exploded");
    });

    const handler = onMessageMock.mock.calls[0][1] as () => void;
    expect(() => handler()).not.toThrow();
    await flush();

    expect(
      log.mock.calls.some(
        (c) => String(c[0]).includes("[test-sync] unexpected failure"),
      ),
    ).toBe(true);
  });
});

describe("runHelloSync", () => {
  it("accounts for every item exactly once when a mid-list timeout bails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attempted: string[] = [];
    const res = await runHelloSync({
      label: "test-sync",
      requestType: "request_test",
      items: ["a", "b", "c", "d"],
      syncOne: async (item) => {
        attempted.push(item);
        if (item === "b") {
          throw new BridgeRequestError("timed out", "timeout", true);
        }
      },
    });

    // "b" fails, "c"/"d" are skipped unattempted, and the books balance.
    expect(attempted).toEqual(["a", "b"]);
    expect(res).toEqual({ synced: 1, failed: 3 });
  });
});
