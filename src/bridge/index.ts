import { loadOrCreateToken } from "./auth.js";
import { ConnectionManager, type ConnectionStatus } from "./connection.js";
import { startServer, DEFAULT_PORT, type BridgeServer } from "./server.js";
import type { InboundMessage, OutboundMessage } from "./protocol.js";

let server: BridgeServer | null = null;
const connections = new ConnectionManager();

export async function startBridge(): Promise<void> {
  if (server) return;

  const port = process.env.NT_BRIDGE_PORT
    ? parseInt(process.env.NT_BRIDGE_PORT, 10)
    : DEFAULT_PORT;

  if (isNaN(port) || port <= 0 || port > 65535) {
    console.error(`[bridge] WARNING: invalid NT_BRIDGE_PORT (${process.env.NT_BRIDGE_PORT}); bridge disabled`);
    return;
  }

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
    server = await startServer({ port, token, connections });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] WARNING: failed to start on port ${port} (${msg}); bridge disabled, MCP continuing`);
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
