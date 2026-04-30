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

export interface RequestCandlesMessage {
  v: 1;
  id: string;
  type: "request_candles";
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
}

export interface CandlePayload {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandlesResponseMessage {
  v: 1;
  id: string;
  type: "candles_response";
  symbol: string;
  timeframe: string;
  candles: CandlePayload[];
}

export interface BarCloseMessage {
  v: 1;
  type: "bar_close";
  symbol: string;
  timeframe: string;
  candle: CandlePayload;
}

export interface ErrorMessage {
  v: 1;
  id: string;
  type: "error";
  message: string;
}

export type InboundMessage =
  | HelloMessage
  | HeartbeatMessage
  | CandlesResponseMessage
  | BarCloseMessage
  | ErrorMessage;
export type OutboundMessage =
  | HelloAckMessage
  | DrawZoneMessage
  | ClearZonesMessage
  | RequestCandlesMessage;
export type AnyMessage = InboundMessage | OutboundMessage;

export type ParseResult =
  | { ok: true; message: AnyMessage }
  | { ok: false; reason: string };

function isCandlePayload(v: unknown): v is CandlePayload {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.timestamp === "number" &&
    typeof c.open === "number" &&
    typeof c.high === "number" &&
    typeof c.low === "number" &&
    typeof c.close === "number" &&
    typeof c.volume === "number"
  );
}

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
    case "candles_response": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "candles_response: missing id" };
      }
      if (typeof obj.symbol !== "string") {
        return { ok: false, reason: "candles_response: missing symbol" };
      }
      if (typeof obj.timeframe !== "string") {
        return { ok: false, reason: "candles_response: missing timeframe" };
      }
      if (!Array.isArray(obj.candles) || !obj.candles.every(isCandlePayload)) {
        return { ok: false, reason: "candles_response: candles must be CandlePayload[]" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "candles_response",
          id: obj.id,
          symbol: obj.symbol,
          timeframe: obj.timeframe,
          candles: obj.candles as CandlePayload[],
        },
      };
    }
    case "bar_close": {
      if (typeof obj.symbol !== "string") {
        return { ok: false, reason: "bar_close: missing symbol" };
      }
      if (typeof obj.timeframe !== "string") {
        return { ok: false, reason: "bar_close: missing timeframe" };
      }
      if (!isCandlePayload(obj.candle)) {
        return { ok: false, reason: "bar_close: invalid candle" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "bar_close",
          symbol: obj.symbol,
          timeframe: obj.timeframe,
          candle: obj.candle,
        },
      };
    }
    case "error": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "error: missing id" };
      }
      if (typeof obj.message !== "string") {
        return { ok: false, reason: "error: missing message" };
      }
      return {
        ok: true,
        message: { v: 1, type: "error", id: obj.id, message: obj.message },
      };
    }
    default:
      return { ok: false, reason: `unknown type: ${obj.type}` };
  }
}

export function encode(message: OutboundMessage): string {
  return JSON.stringify(message);
}
