import { MCP_SOURCE, mcpSource } from "../live/registry.js";

export interface SessionContext {
  id: string;
  source: string;
  connectedAtMs: number;
}

export function createSession(id: string, nowMs: number = Date.now()): SessionContext {
  return { id, source: mcpSource(id), connectedAtMs: nowMs };
}

/** Keeps the legacy "mcp" source. */
export const STDIO_SESSION: SessionContext = {
  id: "stdio",
  source: MCP_SOURCE,
  connectedAtMs: Date.now(),
};
