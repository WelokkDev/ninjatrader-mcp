import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadOrCreateToken } from "../bridge/auth.js";
import {
  HEALTH_PATH,
  HUB_TOKEN_KEY,
  MCP_PATH,
  REPO_ROOT,
  SHUTDOWN_PATH,
  buildFingerprint,
  dataDir,
  hubBaseUrl,
  hubPort,
  type HubHealth,
} from "./config.js";
import { ShimPipe } from "./shim.js";

// Runs per conversation, so keep it light: no database, bridge or server stack.

const SPAWN_WAIT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
const POLL_MS = 200;

export interface ShimMainOptions {
  entry: string;
  args: string[];
}

const log = (line: string): void => console.error(line);
const hubLog = (): string => path.join(dataDir(), "hub.log");

export async function shimMain({ entry, args }: ShimMainOptions): Promise<void> {
  const port = hubPort();
  const token = loadOrCreateToken(HUB_TOKEN_KEY).token;
  const hub = new HubClient(hubBaseUrl(port), token);

  if (args.includes("--status") || args.includes("--stop")) {
    try {
      await hubCommand(hub, port, args.includes("--stop"));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  const pipe = new ShimPipe({
    local: new StdioServerTransport(),
    connect: () => connectToHub(hub, entry),
    onStopped: () => process.exit(0),
    log,
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void pipe.stop(sig));
  }
  // The SDK's stdio transport never reports EOF; a client that died without a
  // signal must not leave a phantom session holding the hub open.
  process.stdin.once("end", () => void pipe.stop("client stdin closed"));
  await pipe.start();
}

async function hubCommand(hub: HubClient, port: number, stop: boolean): Promise<void> {
  const h = await hub.health();
  if (h === "absent") {
    console.log(`no hub listening on ${hubBaseUrl(port)}`);
    return;
  }
  if (!stop) {
    console.log(
      h === "busy"
        ? `a hub is listening on ${hubBaseUrl(port)} but did not answer within ${PROBE_TIMEOUT_MS}ms`
        : JSON.stringify(h, null, 2),
    );
    return;
  }
  await hub.shutdown();
  const gone = await waitUntil(async () => (await hub.health()) === "absent", SPAWN_WAIT_MS);
  console.log(gone ? "hub stopped" : `hub did not stop in time; see ${hubLog()}`);
}

type Probe = HubHealth | "absent" | "busy";

class HubClient {
  constructor(
    readonly base: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async health(): Promise<Probe> {
    let res: Response;
    try {
      res = await fetch(this.base + HEALTH_PATH, {
        headers: this.headers(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout means a hub is listening but blocked (a synchronous query); don't spawn a rival.
      return (err as Error).name === "TimeoutError" ? "busy" : "absent";
    }
    if (res.status === 401) {
      throw new Error(
        `the hub at ${this.base} rejected this process's ${HUB_TOKEN_KEY}; the two read different .env.local files`,
      );
    }
    const body: unknown = res.ok ? await res.json().catch(() => null) : null;
    if (!isHubHealth(body)) {
      throw new Error(
        `something other than a hub answers on ${this.base} (HTTP ${res.status}); ` +
          `set NT_HUB_PORT in .env.local to a free port`,
      );
    }
    return body;
  }

  async shutdown(): Promise<void> {
    await fetch(this.base + SHUTDOWN_PATH, { method: "POST", headers: this.headers() });
  }

  transport(): Transport {
    return new StreamableHTTPClientTransport(new URL(MCP_PATH, this.base), {
      requestInit: { headers: this.headers() },
    });
  }
}

async function connectToHub(hub: HubClient, entry: string): Promise<Transport> {
  let probe = await hub.health();
  if (probe === "absent") spawnHub(entry);
  if (probe === "absent" || probe === "busy" || !probe.ready) probe = await waitReady(hub);
  warnIfStale(probe);
  const t = hub.transport();
  await t.start();
  return t;
}

async function waitReady(hub: HubClient): Promise<HubHealth> {
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    const h = await hub.health();
    if (h !== "absent" && h !== "busy" && h.ready) return h;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`the hub did not come up within ${SPAWN_WAIT_MS / 1000}s; see ${hubLog()}`);
}

function spawnHub(entry: string): void {
  mkdirSync(dataDir(), { recursive: true });
  const logPath = hubLog();
  const fd = openSync(logPath, "a");
  // Racing shims may both spawn; the port is the lock, so the loser just exits.
  const child = spawn(process.execPath, [entry, "--hub"], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  closeSync(fd);
  log(`[shim] no hub running; started one (pid ${child.pid}, log ${logPath})`);
}

function warnIfStale(health: HubHealth): void {
  const mine = buildFingerprint();
  // A rebuild rewrites every output, so any newer file means a newer build.
  if (mine.newestMtimeMs > health.build.newestMtimeMs + 1_000) {
    log(
      `[shim] WARNING: the hub (pid ${health.pid}) runs a build from ${iso(health.build.newestMtimeMs)} ` +
        `but the build on disk is from ${iso(mine.newestMtimeMs)}. Every attached conversation is ` +
        `using the old code — run \`npm stop\` and reconnect to pick up the rebuild.`,
    );
  }
}

async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return cond();
}

const iso = (ms: number): string => new Date(ms).toISOString();

function isHubHealth(v: unknown): v is HubHealth {
  const h = v as Partial<HubHealth> | null;
  return !!h && h.ok === true && typeof h.pid === "number" && typeof h.build === "object";
}
