import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { HubClient, PROBE_TIMEOUT_MS, SPAWN_WAIT_MS, ensureHub, hubLog, waitUntil } from "./client.js";
import { hubBaseUrl, hubPort } from "./config.js";
import { ShimPipe } from "./shim.js";

// Runs per conversation, so keep it light: no database, bridge or server stack.

export interface ShimMainOptions {
  entry: string;
  args: string[];
}

const log = (line: string): void => console.error(line);

export async function shimMain({ entry, args }: ShimMainOptions): Promise<void> {
  const port = hubPort();
  const hub = HubClient.local();

  if (args.includes("--status") || args.includes("--stop")) {
    try {
      await hubCommand(hub, port, args.includes("--stop"), args.includes("--force"));
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

async function hubCommand(hub: HubClient, port: number, stop: boolean, force: boolean): Promise<void> {
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
  const refused = await hub.shutdown(force);
  if (refused !== null) {
    console.error(`refused: ${refused}. \`npm stop -- --force\` ends it.`);
    process.exitCode = 1;
    return;
  }
  const gone = await waitUntil(async () => (await hub.health()) === "absent", SPAWN_WAIT_MS);
  console.log(gone ? "hub stopped" : `hub did not stop in time; see ${hubLog()}`);
}

async function connectToHub(hub: HubClient, entry: string): Promise<Transport> {
  await ensureHub(hub, entry);
  const t = hub.transport();
  await t.start();
  return t;
}
