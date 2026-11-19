import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { startHub, type Hub, type HubSpec } from "../daemon.js";
import { callHubTool } from "../call.js";
import { HubClient } from "../client.js";

const TOKEN = "client-test-token";

let hub: Hub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

async function boot(onSessionEnd: HubSpec["onSessionEnd"] = vi.fn(async () => {})): Promise<Hub> {
  hub = await startHub(
    {
      name: "test-hub",
      version: "0.0.1",
      compose: (server) => {
        server.tool("echo", "echo a word", { word: z.string() }, async ({ word }) => ({
          content: [{ type: "text", text: word }],
        }));
        server.tool("refuse", "always fails", {}, async () => ({
          content: [{ type: "text", text: "refused" }],
          isError: true,
        }));
      },
      onSessionEnd,
    },
    {
      port: 0,
      token: TOKEN,
      resident: true,
      idleExitMs: 30,
      onIdleExit: vi.fn(),
      // Newer than any build on disk, so no stale-build warning.
      build: { newestMtimeMs: Date.now() + 3_600_000, files: 1 },
      log: () => {},
    },
  );
  hub.setReady();
  return hub;
}

const clientFor = (h: Hub, token = TOKEN): HubClient => new HubClient(`http://127.0.0.1:${h.port}`, token);

describe("callHubTool", () => {
  it("returns the tool's result and ends its session", async () => {
    const onSessionEnd = vi.fn(async () => {});
    const h = await boot(onSessionEnd);
    const res = await callHubTool("echo", { word: "green" }, { hub: clientFor(h) });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toBe("green");
    await vi.waitFor(() => expect(h.sessions()).toHaveLength(0));
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  it("passes a tool failure through as isError", async () => {
    const h = await boot();
    const res = await callHubTool("refuse", {}, { hub: clientFor(h) });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toBe("refused");
  });

  it("throws when the hub rejects the token", async () => {
    const h = await boot();
    await expect(callHubTool("echo", { word: "x" }, { hub: clientFor(h, "wrong-token") })).rejects.toThrow(
      /rejected this process's NT_HUB_TOKEN/,
    );
  });
});
