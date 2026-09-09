import { loadOrCreateToken } from "./auth.js";
import { ConnectionManager, type ConnectionStatus } from "./connection.js";
import { startServer, DEFAULT_PORT, DEFAULT_HOST, type BridgeServer } from "./server.js";
import { envSetting } from "../core/env-local.js";
import type { InboundMessage, OutboundMessage } from "./protocol.js";

export { BridgeRequestError, type BridgeErrorKind } from "./connection.js";

let server: BridgeServer | null = null;
const connections = new ConnectionManager();

export async function startBridge(): Promise<void> {
  if (server) return;


  const rawPort = envSetting("NT_BRIDGE_PORT");
  const port = rawPort ? parseInt(rawPort, 10) : DEFAULT_PORT;

  if (isNaN(port) || port <= 0 || port > 65535) {
    console.error(`[bridge] WARNING: invalid NT_BRIDGE_PORT (${rawPort}); bridge disabled`);
    return;
  }

  const host = envSetting("NT_BRIDGE_HOST") ?? DEFAULT_HOST;

  let token: string;
  try {
    const result = loadOrCreateToken();
    token = result.token;
    if (result.created) {
      console.error(`[bridge] generated new token; wrote ${result.path}`);
      console.error(`[bridge] paste this into the NT addon config: ${token}`);
    } else {
      console.error(`[bridge] using token from ${result.path}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] WARNING: token init failed (${msg}); bridge disabled`);
    return;
  }

  try {
    server = await startServer({ port, host, token, connections });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] WARNING: failed to start on ${host}:${port} (${msg}); bridge disabled, MCP continuing`);
    server = null;
  }
}

export async function stopBridge(): Promise<void> {
  if (!server) return;
  await server.stop();
  server = null;
}

export function getBridgeStatus(): ConnectionStatus & { listening: boolean; port: number | null } {
  return {
    ...connections.getStatus(),
    listening: server !== null,
    port: server?.port ?? null,
  };
}

export function isConnected(): boolean {
  return connections.isConnected();
}

/** AddOn write caps; null (disconnected or pre-caps AddOn) means callers assume ["place_order"]. */
export function getAddonCaps(): string[] | null {
  return connections.getCaps();
}

export function onMessage<T extends InboundMessage["type"]>(
  type: T,
  handler: (message: Extract<InboundMessage, { type: T }>) => void,
): void {
  connections.onMessage(type, handler);
}

export function send(message: OutboundMessage): boolean {
  return connections.send(message);
}

export function request(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
): Promise<InboundMessage> {
  return connections.request(type, payload, timeoutMs);
}
