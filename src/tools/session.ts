import { MCP_SOURCE, mcpSource } from "../live/registry.js";

export interface SessionContext {
  id: string;
  source: string;
  connectedAtMs: number;
  /** symbol → drawing ids; clear_zones' default scope. */
  drawn: Map<string, Set<string>>;
}

export function drawingCount(drawn: SessionContext["drawn"]): number {
  let n = 0;
  for (const ids of drawn.values()) n += ids.size;
  return n;
}

export function createSession(id: string, nowMs: number = Date.now()): SessionContext {
  return { id, source: mcpSource(id), connectedAtMs: nowMs, drawn: new Map() };
}

/** Keeps the legacy "mcp" source. */
export const STDIO_SESSION: SessionContext = {
  id: "stdio",
  source: MCP_SOURCE,
  connectedAtMs: Date.now(),
  drawn: new Map(),
};
