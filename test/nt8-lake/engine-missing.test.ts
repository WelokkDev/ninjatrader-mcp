import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Hub } from "../../src/hub/daemon.js";

vi.mock("@duckdb/node-api", () => {
  throw new Error("forced: native binary failed to load");
});

let hub: Hub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

describe("without a loadable DuckDB", () => {
  it("the lake reports the engine as unavailable", async () => {
    const { openEngine, EngineUnavailableError } = await import("../../src/nt8-lake/engine.js");
    await expect(openEngine()).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it("the hub still starts and serves the generic tools", async () => {
    const { registerGenericTools } = await import("../../src/server.js");
    const { startHub } = await import("../../src/hub/daemon.js");
    hub = await startHub(
      { name: "lake-test", version: "0", compose: (server, session) => registerGenericTools(server, { session }), onSessionEnd: async () => {} },
      { port: 0, token: "t", resident: true, idleExitMs: 60_000, onIdleExit: () => {}, build: { newestMtimeMs: 1, files: 1 }, log: () => {} },
    );
    hub.setReady();
    const client = new Client({ name: "lake-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`), {
        requestInit: { headers: { authorization: "Bearer t" } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_candles", "prefetch_ticks", "tick_lake_status"]));
    await client.close();
  });
});
