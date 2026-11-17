import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGenericTools } from "../../src/server.js";
import type { TickFetchManager } from "../../src/nt8-lake/fetch-job.js";
import { ingest } from "../../src/nt8-lake/ops.js";
import { rowsSource } from "../../src/nt8-lake/source.js";
import { createTickToolHandlers } from "../../src/tools/prefetch-ticks.js";
import { context, removeTmpRoots, syntheticDay, tmpRoot } from "./helpers.js";

const TICK_TOOLS = ["prefetch_ticks", "prefetch_ticks_status", "prefetch_ticks_cancel", "tick_lake_status", "tick_lake_show"];

async function toolNames(): Promise<string[]> {
  const server = new McpServer({ name: "tick-tools-test", version: "0" });
  registerGenericTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tick-tools-test", version: "0" });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

const saved = process.env.NT_TICK_PROBE;
afterEach(() => {
  if (saved === undefined) delete process.env.NT_TICK_PROBE;
  else process.env.NT_TICK_PROBE = saved;
  removeTmpRoots();
});

const text = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("tick tools", () => {
  it("registers the five tick tools, and tick_fetch_probe only with NT_TICK_PROBE=1", async () => {
    process.env.NT_TICK_PROBE = "0";
    const without = await toolNames();
    for (const t of TICK_TOOLS) expect(without).toContain(t);
    expect(without).not.toContain("tick_fetch_probe");
    process.env.NT_TICK_PROBE = "1";
    expect(await toolNames()).toContain("tick_fetch_probe");
  });

  it("reads the lake through status and show, and reports a refusal as an error", async () => {
    const root = tmpRoot();
    await ingest(context(root), rowsSource({ instrument: "MNQ 12-26", streams: syntheticDay("2026-10-28") }));
    const manager = { start: async () => ({ error: "NT_TICK_DROP_PATH is not set" }) } as unknown as TickFetchManager;
    const h = createTickToolHandlers({ manager, lake: () => context(root), owner: "me" });

    const status = await h.lakeStatus({ contract: "MNQ 12-26" });
    expect(text(status).days).toEqual([expect.objectContaining({ contract: "MNQ_12-26", session: "2026-10-28", state: "stored", take: 1 })]);
    const show = await h.lakeShow({ contract: "MNQ 12-26", session: "2026-10-28" });
    expect(text(show)).toMatchObject({ instrument: "MNQ 12-26", state: { selected: 1, tier: "RAW" } });
    const missing = await h.lakeShow({ contract: "MNQ 12-26", session: "2026-10-27" });
    expect(missing.isError).toBe(true);
    expect(text(missing).error).toBe("MNQ_12-26 2026-10-27 is not in the lake");

    const start = await h.start({ symbol: "MNQ", start: "2026-10-28", end: "2026-10-28" });
    expect(start).toMatchObject({ isError: true });
    expect(text(start).error).toBe("NT_TICK_DROP_PATH is not set");
  });
});
