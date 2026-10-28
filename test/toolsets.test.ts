import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  announceToolsets,
  processToolsets,
  registerGenericTools,
  resolveToolsets,
  type Toolset,
} from "../src/server.js";

const LIVE_FEED_TOOLS = [
  "subscribe_live_bars",
  "unsubscribe_live_bars",
  "live_feed_status",
  "subscribe_live_positions",
  "unsubscribe_live_positions",
];

async function registeredNames(toolsets?: ReadonlySet<Toolset>): Promise<string[]> {
  const server = new McpServer({ name: "toolsets-test", version: "0" });
  registerGenericTools(server, toolsets ? { toolsets } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "toolsets-test", version: "0" });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("resolveToolsets", () => {
  it("unset, blank and 'all' register everything", () => {
    for (const raw of [undefined, "", "  ", "all", "core, all"]) {
      expect([...resolveToolsets(raw).toolsets].sort()).toEqual(["core", "live-feeds"]);
    }
  });

  it("'core' alone leaves the live feeds out", () => {
    expect([...resolveToolsets("core").toolsets]).toEqual(["core"]);
  });

  it("always includes core and tolerates spaces", () => {
    expect([...resolveToolsets(" live-feeds ").toolsets].sort()).toEqual(["core", "live-feeds"]);
  });

  it("serves everything on an unknown name rather than hide tools the caller asked for", () => {
    const choice = resolveToolsets("core,live-feed");
    expect([...choice.toolsets].sort()).toEqual(["core", "live-feeds"]);
    expect(choice.unknown).toEqual(["live-feed"]);
  });
});

describe("announceToolsets", () => {
  it("warns with the typo and the valid names", () => {
    const lines: string[] = [];
    announceToolsets("core,live-feed", (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/WARNING .*unknown toolset "live-feed" \(valid: core, live-feeds, all\)/);
  });

  it("names what a valid choice leaves out", () => {
    const lines: string[] = [];
    announceToolsets("core", (l) => lines.push(l));
    expect(lines).toEqual(["[server] toolsets: core (NT_TOOLSETS leaves out: live-feeds)"]);
  });
});

describe("registerGenericTools toolsets", () => {
  const savedEnv = process.env.NT_TOOLSETS;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NT_TOOLSETS;
    else process.env.NT_TOOLSETS = savedEnv;
  });

  it("'core' hides exactly the five live-feed tools", async () => {
    const all = await registeredNames(resolveToolsets("all").toolsets);
    const core = await registeredNames(resolveToolsets("core").toolsets);
    expect(all.filter((n) => !core.includes(n)).sort()).toEqual([...LIVE_FEED_TOOLS].sort());
    expect(core).toContain("get_positions");
  });

  // The only test here that touches the per-process choice, which vitest resets per file.
  it("reads NT_TOOLSETS once per process and uses it when no option is passed", async () => {
    const lines: string[] = [];
    process.env.NT_TOOLSETS = "core";
    expect([...processToolsets((l) => lines.push(l))]).toEqual(["core"]);
    process.env.NT_TOOLSETS = "all";
    expect([...processToolsets((l) => lines.push(l))]).toEqual(["core"]);
    expect(lines).toHaveLength(1);
    const names = await registeredNames();
    for (const tool of LIVE_FEED_TOOLS) expect(names).not.toContain(tool);
  });
});
