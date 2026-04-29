export const PROTOCOL_VERSION = 1;

export interface HelloMessage {
  v: 1;
  type: "hello";
  ntVersion: string;
  instruments: string[];
}

export interface HeartbeatMessage {
  v: 1;
  type: "heartbeat";
}

export interface HelloAckMessage {
  v: 1;
  type: "hello_ack";
  serverVersion: string;
}

export interface DrawZoneMessage {
  v: 1;
  type: "draw_zone";
  id: string;
  symbol: string;
  proximal: number;
  distal: number;
}

export interface ClearZonesMessage {
  v: 1;
  type: "clear_zones";
  symbol: string;
  id?: string;
}

export type InboundMessage = HelloMessage | HeartbeatMessage;
export type OutboundMessage = HelloAckMessage | DrawZoneMessage | ClearZonesMessage;
export type AnyMessage = InboundMessage | OutboundMessage;

export type ParseResult =
  | { ok: true; message: AnyMessage }
  | { ok: false; reason: string };

export function parseMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: `unsupported protocol version: ${String(obj.v)}` };
  }
  if (typeof obj.type !== "string") {
    return { ok: false, reason: "missing type" };
  }

  switch (obj.type) {
    case "hello": {
      if (typeof obj.ntVersion !== "string") {
        return { ok: false, reason: "hello: missing ntVersion" };
      }
      if (!Array.isArray(obj.instruments) || !obj.instruments.every((s) => typeof s === "string")) {
        return { ok: false, reason: "hello: instruments must be string[]" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "hello",
          ntVersion: obj.ntVersion,
          instruments: obj.instruments as string[],
        },
      };
    }
    case "heartbeat":
      return { ok: true, message: { v: 1, type: "heartbeat" } };
    default:
      return { ok: false, reason: `unknown type: ${obj.type}` };
  }
}

export function encode(message: OutboundMessage): string {
  return JSON.stringify(message);
}
