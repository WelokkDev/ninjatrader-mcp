import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { HubClient, ensureHub } from "./client.js";

// Kept out of client.ts, which must stay light: the SDK Client pulls in ajv.

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export interface CallHubToolOptions {
  hub?: HubClient;
  entry?: string;
  clientName?: string;
  timeoutMs?: number;
}

export type HubToolResult = Awaited<ReturnType<Client["callTool"]>>;

export async function callHubTool(
  name: string,
  args: Record<string, unknown>,
  opts: CallHubToolOptions = {},
): Promise<HubToolResult> {
  const hub = opts.hub ?? HubClient.local();
  await ensureHub(hub, opts.entry);
  const transport = hub.transport();
  const client = new Client({ name: opts.clientName ?? "ninjatrader-mcp-script", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args }, undefined, {
      timeout: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    });
  } finally {
    // Otherwise the hub holds the session until its stale sweep.
    await transport.terminateSession().catch(() => undefined);
    await client.close();
  }
}
