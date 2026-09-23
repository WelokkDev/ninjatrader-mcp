import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHub, type Hub, type HubOptions, type HubSpec } from "../daemon.js";

const TOKEN = "hub-test-token";

let hub: Hub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

function spec(over: Partial<HubSpec> = {}): HubSpec {
  return {
    name: "test-hub",
    version: "0.0.1",
    compose: (server, session) => {
      server.tool("whoami", "this session's id", {}, async () => ({
        content: [{ type: "text", text: session.id }],
      }));
    },
    onSessionEnd: vi.fn(async () => {}),
    ...over,
  };
}

function options(over: Partial<HubOptions> = {}): HubOptions {
  return {
    port: 0,
    token: TOKEN,
    resident: true,
    idleExitMs: 30,
    onIdleExit: vi.fn(),
    build: { newestMtimeMs: 1, files: 1 },
    log: () => {},
    ...over,
  };
}

async function boot(s = spec(), o = options()): Promise<Hub> {
  hub = await startHub(s, o);
  hub.setReady();
  return hub;
}

function mcpUrl(h: Hub): URL {
  return new URL(`http://127.0.0.1:${h.port}/mcp`);
}

async function attach(h: Hub, token = TOKEN) {
  const transport = new StreamableHTTPClientTransport(mcpUrl(h), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

async function whoami(client: Client): Promise<string> {
  const res = await client.callTool({ name: "whoami", arguments: {} });
  return (res.content as Array<{ text: string }>)[0].text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("hub sessions", () => {
  it("gives each client its own session and tool closure", async () => {
    const h = await boot();
    const a = await attach(h);
    const b = await attach(h);
    const [ia, ib] = [await whoami(a.client), await whoami(b.client)];
    expect(ia).not.toBe(ib);
    expect(h.sessions().map((s) => s.id).sort()).toEqual([ia, ib].sort());
    expect(h.sessions().every((s) => s.source === `mcp:${s.id}`)).toBe(true);
    await a.client.close();
    await b.client.close();
  });

  it("ends the session and runs cleanup when the client terminates it", async () => {
    const s = spec();
    const h = await boot(s);
    const a = await attach(h);
    const id = await whoami(a.client);
    await a.transport.terminateSession();
    await vi.waitFor(() => expect(h.sessions()).toHaveLength(0));
    expect(s.onSessionEnd).toHaveBeenCalledTimes(1);
    expect((s.onSessionEnd as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id });
    await a.transport.close();
  });

  it("ends a session whose event stream stays gone past the grace period", async () => {
    const s = spec();
    const h = await boot(s, options({ detachGraceMs: 30 }));
    const a = await attach(h);
    await vi.waitFor(() => expect(h.sessions()[0]?.attached).toBe(true));
    await a.transport.close(); // no DELETE, like a crashed shim
    await vi.waitFor(() => expect(h.sessions()).toHaveLength(0), { timeout: 2000 });
    expect(s.onSessionEnd).toHaveBeenCalledTimes(1);
  });

  it("closes every session with cleanup on stop", async () => {
    const s = spec();
    const h = await boot(s);
    const a = await attach(h);
    const b = await attach(h);
    await h.stop();
    expect(s.onSessionEnd).toHaveBeenCalledTimes(2);
    await a.transport.close();
    await b.transport.close();
  });
});

describe("hub surface", () => {
  it("refuses a bad token everywhere", async () => {
    const h = await boot();
    const res = await fetch(`http://127.0.0.1:${h.port}/health`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
    await expect(attach(h, "nope")).rejects.toThrow();
    expect(h.sessions()).toHaveLength(0);
  });

  it("answers 503 on /mcp until the runtime is ready", async () => {
    hub = await startHub(spec(), options());
    await expect(attach(hub)).rejects.toThrow(/hub is starting/);
    hub.setReady();
    const a = await attach(hub);
    expect(await whoami(a.client)).toBeTruthy();
    await a.client.close();
  });

  it("leaves no session behind when the opener is not an initialize", async () => {
    const h = await boot();
    const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    await sleep(20);
    expect(h.sessions()).toHaveLength(0);
  });

  it("reports health and honours a shutdown request", async () => {
    const onShutdownRequest = vi.fn();
    const h = await boot(spec(), options({ onShutdownRequest }));
    const auth = { authorization: `Bearer ${TOKEN}` };
    const health = await (await fetch(`http://127.0.0.1:${h.port}/health`, { headers: auth })).json();
    expect(health).toMatchObject({ ok: true, ready: true, sessions: 0, resident: true, port: h.port });
    const res = await fetch(`http://127.0.0.1:${h.port}/shutdown`, { method: "POST", headers: auth });
    expect(res.status).toBe(202);
    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses a session past the cap and frees the slot when one leaves", async () => {
    const h = await boot(spec(), options({ maxSessions: 2 }));
    const a = await attach(h);
    const b = await attach(h);
    await expect(attach(h)).rejects.toThrow();
    expect(h.sessions()).toHaveLength(2);

    await a.transport.terminateSession();
    await vi.waitFor(() => expect(h.sessions()).toHaveLength(1));
    const c = await attach(h);
    expect(await whoami(c.client)).toBeTruthy();

    await a.transport.close();
    await b.client.close();
    await c.client.close();
  });
});

describe("hub idle exit", () => {
  it("exits after the grace window with no sessions, unless held open", async () => {
    const held = options({ resident: false, holdOpen: () => true });
    hub = await startHub(spec(), held);
    await sleep(120);
    expect(held.onIdleExit).not.toHaveBeenCalled();
    await hub.stop();

    const free = options({ resident: false });
    hub = await startHub(spec(), free);
    await vi.waitFor(() => expect(free.onIdleExit).toHaveBeenCalledTimes(1));
  });

  it("an attached session cancels the idle exit; the last one leaving re-arms it", async () => {
    const o = options({ resident: false, idleExitMs: 60 });
    const h = await boot(spec(), o);
    const a = await attach(h);
    await sleep(150);
    expect(o.onIdleExit).not.toHaveBeenCalled();
    await a.transport.terminateSession();
    await vi.waitFor(() => expect(o.onIdleExit).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await a.transport.close();
  });
});
