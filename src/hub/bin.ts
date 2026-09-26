import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadOrCreateToken } from "../bridge/auth.js";
import { endSession, startRuntime, stopRuntime } from "../server.js";
import { registerListSessions } from "../tools/list-sessions.js";
import { STDIO_SESSION, type SessionContext } from "../tools/session.js";
import { HUB_HOST, HUB_IDLE_EXIT_MS, HUB_TOKEN_KEY, buildFingerprint, hubPort } from "./config.js";
import { startHub, type Hub } from "./daemon.js";

export interface BinSpec {
  name: string;
  version: string;
  /** Runs once per session. */
  compose: (server: McpServer, session: SessionContext) => void;
  /** Runs once per process. */
  onRuntimeReady?: () => void | Promise<void>;
  holdOpen?: () => boolean;
}

export async function runBin(spec: BinSpec, argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--hub")) await runHub(spec, argv.includes("--resident"));
  else await runStdio(spec);
}

async function runStdio(spec: BinSpec): Promise<void> {
  const server = new McpServer({ name: spec.name, version: spec.version });
  spec.compose(server, STDIO_SESSION);
  await server.connect(new StdioServerTransport());
  console.error(`${spec.name} running on stdio (single client)`);
  await startRuntime();
  await spec.onRuntimeReady?.();
  const shutdown = async (why: string): Promise<void> => {
    console.error(`${why}, shutting down`);
    await stopRuntime();
    process.exit(0);
  };
  onSignal((signal) => shutdown(`Received ${signal}`));
  // The SDK's stdio transport never reports EOF; without this a dead client leaves the bridge port owned by a ghost.
  process.stdin.once("end", () => void shutdown("Client stdin closed"));
}

async function runHub(spec: BinSpec, resident: boolean): Promise<void> {
  const port = hubPort();
  const token = loadOrCreateToken(HUB_TOKEN_KEY).token;
  let hub: Hub;
  let exiting = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.error(`[hub] shutting down: ${reason}`);
    await hub.stop();
    await stopRuntime();
    process.exit(0);
  };
  try {
    // Bind first: the port is the one-hub lock, so a losing twin exits before starting the bridge.
    hub = await startHub(
      {
        name: spec.name,
        version: spec.version,
        compose: (server, session) => {
          spec.compose(server, session);
          registerListSessions(server, session, { hub, buildOnDisk: buildFingerprint });
        },
        onSessionEnd: endSession,
      },
      {
        port,
        token,
        resident,
        idleExitMs: HUB_IDLE_EXIT_MS,
        holdOpen: spec.holdOpen,
        onIdleExit: () => void shutdown("idle, no sessions"),
        onShutdownRequest: () => void shutdown("stop requested"),
        build: buildFingerprint(),
      },
    );
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      console.error(`[hub] another hub already owns ${HUB_HOST}:${port}; exiting`);
      process.exit(3);
    }
    throw err;
  }
  console.error(
    `[hub] ${spec.name} pid ${process.pid} listening on ${HUB_HOST}:${hub.port}` +
      (resident ? " (resident)" : ` (exits after ${HUB_IDLE_EXIT_MS / 1000}s without sessions)`),
  );
  onSignal((signal) => shutdown(signal));
  await startRuntime();
  await spec.onRuntimeReady?.();
  hub.setReady();
  console.error("[hub] ready");
}

function onSignal(handler: (signal: string) => Promise<void>): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void handler(sig));
  }
}
