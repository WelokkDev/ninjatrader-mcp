export const PROTOCOL_VERSION = 1;

export interface HelloMessage {
  v: 1;
  type: "hello";
  ntVersion: string;
  instruments: string[];
  // NT8-configured timezone id (bars are stamped in it); older AddOns omit it.
  timeZone?: string;
}

export interface InstrumentsUpdateMessage {
  v: 1;
  type: "instruments_update";
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
  // Unix seconds, matching the candle protocol. Both optional:
  // omit fromTs to anchor the rectangle to a fixed bars-back fallback,
  // omit toTs to extend it to the current bar.
  fromTs?: number;
  toTs?: number;
}

export interface DrawStyle {
  color?: string; // "#rrggbb"
  opacity?: number; // 0..1 fill opacity (rectangles)
  label?: string; // optional companion text rendered at the shape's anchor
}

/** Discriminated chart primitives. Timestamps are unix seconds (ET calendar
 *  dates per the draw_zone timezone convention). */
export type DrawShape =
  | { kind: "rectangle"; proximal: number; distal: number; fromTs?: number; toTs?: number }
  | { kind: "hline"; price: number; fromTs?: number; toTs?: number }
  | { kind: "vline"; ts: number }
  | { kind: "text"; ts: number; price: number; text: string };

export interface DrawMessage {
  v: 1;
  type: "draw";
  id: string;
  symbol: string;
  shape: DrawShape;
  style?: DrawStyle;
}

export interface ClearZonesMessage {
  v: 1;
  type: "clear_zones";
  // Optional: omit to clear on every chart that has the renderer attached.
  symbol?: string;
  // Single-id form (kept for compatibility); prefer `ids` for batches.
  id?: string;
  ids?: string[];
}

export interface RequestCandlesMessage {
  v: 1;
  id: string;
  type: "request_candles";
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  // Internal session-template name (e.g. "cme_us_index_futures_eth").
  // Required: the NT8 add-on fails the request closed if missing or
  // unknown rather than falling back to a default
  tradingHoursTemplate: string;
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
  // Live-feed extensions — optional so a legacy AddOn stays parseable.
  // Monotonic per subscription; a jump = undelivered bars, a reset = re-seed.
  seq?: number;
  // Resolved NT8 contract (e.g. "MNQ 09-26") — makes rolls visible.
  contract?: string;
  // Closed well before emission (catch-up); act-on-close consumers skip these.
  backfill?: boolean;
}

export interface SubscribeBarsMessage {
  v: 1;
  id: string;
  type: "subscribe_bars";
  symbol: string;
  timeframe: string;
  // Same fail-closed template contract as request_candles.
  tradingHoursTemplate: string;
}

export interface UnsubscribeBarsMessage {
  v: 1;
  id: string;
  type: "unsubscribe_bars";
  symbol: string;
  timeframe: string;
}

export interface SubscribeAckMessage {
  v: 1;
  id: string;
  type: "subscribe_ack";
  symbol: string;
  timeframe: string;
  // Resolved NT8 contract FullName the stream is bound to.
  contract: string;
  // Bars in the C# seed request (0 on an alreadyActive re-subscribe ack).
  seedCount: number;
  // Unix seconds of the last seeded bar; 0 when none.
  seedLastTs: number;
  // The subscription already existed C#-side (idempotent re-subscribe).
  alreadyActive: boolean;
}

export interface UnsubscribeAckMessage {
  v: 1;
  id: string;
  type: "unsubscribe_ack";
  symbol: string;
  timeframe: string;
  removed: boolean;
}

export interface RequestSessionCalendarMessage {
  v: 1;
  id: string;
  type: "request_session_calendar";
  // Internal session-template name (e.g. "cme_us_index_futures_eth").
  tradingHoursTemplate: string;
}

export interface SessionCalendarResponseMessage {
  v: 1;
  id: string;
  type: "session_calendar_response";
  // NT8 TradingHours.Holidays — fully-closed dates (YYYY-MM-DD).
  holidays: Array<{ date: string; description: string }>;
  // NT8 TradingHours.PartialHolidays — dates only; NT8 exposes no times.
  partialHolidays: Array<{
    date: string;
    isEarlyClose: boolean;
    isLateBegin: boolean;
    description: string;
  }>;
}

export interface RequestOpenChartsMessage {
  v: 1;
  id: string;
  type: "request_open_charts";
}

/** One open chart tab. `symbol` uses the roster/draw convention
 *  (MasterInstrument.Name); `timeframe` is compact ("5m"/"1h") when the
 *  NT8 bars type maps to the SUPPORTED_TIMEFRAMES vocabulary, otherwise
 *  NT8's own display string (e.g. "150 Tick"). Empty strings mean the tab
 *  hadn't finished loading when read. */
export interface OpenChartEntry {
  window: string;
  symbol: string;
  instrument: string;
  timeframe: string;
  isActive: boolean;
  hasRenderer: boolean;
}

export interface OpenChartsResponseMessage {
  v: 1;
  id: string;
  type: "open_charts_response";
  charts: OpenChartEntry[];
  skippedWindows: number;
}

// ---------- live position tracking ----------
// Read-only account observation. Enum-ish fields carry NT8's own ToString()
// values ("Long", "StopMarket", "Working", ...) so new values pass through.

export interface PositionPayload {
  instrument: string; // resolved contract, e.g. "MNQ 09-26"
  symbol: string; // master symbol, e.g. "MNQ" — matches the roster/draw convention
  marketPosition: string;
  quantity: number;
  averagePrice?: number;
  pointValue?: number;
  tickSize?: number;
  // Best-effort from NT8 market data; omitted when no data is flowing.
  unrealizedPnl?: number;
  marketPrice?: number;
  marketPriceTs?: number;
}

export interface WorkingOrderPayload {
  orderId: string;
  name: string; // NT8 order name, e.g. "Stop loss" / "Profit target"
  instrument: string;
  symbol: string;
  action: string; // Buy | Sell | SellShort | BuyToCover
  orderType: string; // Market | Limit | StopMarket | StopLimit | ...
  state: string; // NT8 OrderState string
  quantity: number;
  filled: number;
  limitPrice?: number;
  stopPrice?: number;
  avgFillPrice?: number;
  time?: number; // unix seconds
  oco?: string;
}

export interface ExecutionPayload {
  executionId: string;
  orderId: string;
  instrument: string;
  symbol: string;
  side: string; // NT8 MarketPosition of the fill: "Long" = buy, "Short" = sell
  quantity: number;
  price?: number;
  time?: number; // unix seconds
  orderName?: string;
  commission?: number;
}

export interface AccountSnapshotPayload {
  name: string;
  connection?: string;
  connectionStatus?: string;
  denomination?: string;
  realizedPnl?: number;
  cashValue?: number;
  netLiquidation?: number;
  positions: PositionPayload[];
  orders: WorkingOrderPayload[]; // working (non-terminal) orders only
}

export interface RequestPositionsMessage {
  v: 1;
  id: string;
  type: "request_positions";
}

export interface PositionsResponseMessage {
  v: 1;
  id: string;
  type: "positions_response";
  accounts: AccountSnapshotPayload[];
}

export interface SubscribePositionsMessage {
  v: 1;
  id: string;
  type: "subscribe_positions";
}

export interface SubscribePositionsAckMessage {
  v: 1;
  id: string;
  type: "subscribe_positions_ack";
  accounts: string[];
  alreadyActive: boolean;
}

export interface UnsubscribePositionsMessage {
  v: 1;
  id: string;
  type: "unsubscribe_positions";
}

export interface UnsubscribePositionsAckMessage {
  v: 1;
  id: string;
  type: "unsubscribe_positions_ack";
  removed: boolean;
}

/** Unsolicited full snapshot (after subscribe / reconnect / roster change);
 *  shares the position_event seq stream for ordering and drop detection. */
export interface PositionSyncMessage {
  v: 1;
  type: "position_sync";
  accounts: AccountSnapshotPayload[];
  seq?: number;
  reason?: string;
  ts?: number; // unix seconds at emit
}

export interface PositionEventMessage {
  v: 1;
  type: "position_event";
  account: string;
  kind: "position" | "order" | "execution";
  seq?: number;
  ts?: number; // unix seconds at emit
  // Exactly one of these is present, matching `kind`.
  position?: PositionPayload;
  order?: WorkingOrderPayload;
  execution?: ExecutionPayload;
  // kind="position" only: NT8 Operation (Add | Update | Remove).
  operation?: string;
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
  | InstrumentsUpdateMessage
  | CandlesResponseMessage
  | BarCloseMessage
  | SessionCalendarResponseMessage
  | OpenChartsResponseMessage
  | SubscribeAckMessage
  | UnsubscribeAckMessage
  | PositionsResponseMessage
  | SubscribePositionsAckMessage
  | UnsubscribePositionsAckMessage
  | PositionSyncMessage
  | PositionEventMessage
  | ErrorMessage;
export type OutboundMessage =
  | HelloAckMessage
  | DrawZoneMessage
  | DrawMessage
  | ClearZonesMessage
  | RequestCandlesMessage
  | RequestSessionCalendarMessage
  | RequestOpenChartsMessage
  | SubscribeBarsMessage
  | UnsubscribeBarsMessage
  | RequestPositionsMessage
  | SubscribePositionsMessage
  | UnsubscribePositionsMessage;
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

// Optional-field check: absent is fine, present-but-wrong-type is not.
function optNum(v: unknown): boolean {
  return v === undefined || typeof v === "number";
}
function optStr(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function isPositionPayload(v: unknown): v is PositionPayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.instrument === "string" &&
    typeof p.symbol === "string" &&
    typeof p.marketPosition === "string" &&
    typeof p.quantity === "number" &&
    optNum(p.averagePrice) &&
    optNum(p.pointValue) &&
    optNum(p.tickSize) &&
    optNum(p.unrealizedPnl) &&
    optNum(p.marketPrice) &&
    optNum(p.marketPriceTs)
  );
}

function isWorkingOrderPayload(v: unknown): v is WorkingOrderPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.orderId === "string" &&
    typeof o.name === "string" &&
    typeof o.instrument === "string" &&
    typeof o.symbol === "string" &&
    typeof o.action === "string" &&
    typeof o.orderType === "string" &&
    typeof o.state === "string" &&
    typeof o.quantity === "number" &&
    typeof o.filled === "number" &&
    optNum(o.limitPrice) &&
    optNum(o.stopPrice) &&
    optNum(o.avgFillPrice) &&
    optNum(o.time) &&
    optStr(o.oco)
  );
}

function isExecutionPayload(v: unknown): v is ExecutionPayload {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  return (
    typeof x.executionId === "string" &&
    typeof x.orderId === "string" &&
    typeof x.instrument === "string" &&
    typeof x.symbol === "string" &&
    typeof x.side === "string" &&
    typeof x.quantity === "number" &&
    optNum(x.price) &&
    optNum(x.time) &&
    optStr(x.orderName) &&
    optNum(x.commission)
  );
}

function isAccountSnapshotPayload(v: unknown): v is AccountSnapshotPayload {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.name === "string" &&
    optStr(a.connection) &&
    optStr(a.connectionStatus) &&
    optStr(a.denomination) &&
    optNum(a.realizedPnl) &&
    optNum(a.cashValue) &&
    optNum(a.netLiquidation) &&
    Array.isArray(a.positions) &&
    a.positions.every(isPositionPayload) &&
    Array.isArray(a.orders) &&
    a.orders.every(isWorkingOrderPayload)
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
          ...(typeof obj.timeZone === "string" ? { timeZone: obj.timeZone } : {}),
        },
      };
    }
    case "heartbeat":
      return { ok: true, message: { v: 1, type: "heartbeat" } };
    case "instruments_update": {
      if (!Array.isArray(obj.instruments) || !obj.instruments.every((s) => typeof s === "string")) {
        return { ok: false, reason: "instruments_update: instruments must be string[]" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "instruments_update",
          instruments: obj.instruments as string[],
        },
      };
    }
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
      if (obj.seq !== undefined && typeof obj.seq !== "number") {
        return { ok: false, reason: "bar_close: seq must be a number" };
      }
      if (obj.contract !== undefined && typeof obj.contract !== "string") {
        return { ok: false, reason: "bar_close: contract must be a string" };
      }
      if (obj.backfill !== undefined && typeof obj.backfill !== "boolean") {
        return { ok: false, reason: "bar_close: backfill must be a boolean" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "bar_close",
          symbol: obj.symbol,
          timeframe: obj.timeframe,
          candle: obj.candle,
          ...(typeof obj.seq === "number" ? { seq: obj.seq } : {}),
          ...(typeof obj.contract === "string" ? { contract: obj.contract } : {}),
          ...(typeof obj.backfill === "boolean" ? { backfill: obj.backfill } : {}),
        },
      };
    }
    case "session_calendar_response": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "session_calendar_response: missing id" };
      }
      const isHoliday = (v: unknown): v is { date: string; description: string } => {
        if (!v || typeof v !== "object") return false;
        const h = v as Record<string, unknown>;
        return typeof h.date === "string" && typeof h.description === "string";
      };
      const isPartial = (
        v: unknown,
      ): v is { date: string; isEarlyClose: boolean; isLateBegin: boolean; description: string } => {
        if (!v || typeof v !== "object") return false;
        const p = v as Record<string, unknown>;
        return (
          typeof p.date === "string" &&
          typeof p.isEarlyClose === "boolean" &&
          typeof p.isLateBegin === "boolean" &&
          typeof p.description === "string"
        );
      };
      if (!Array.isArray(obj.holidays) || !obj.holidays.every(isHoliday)) {
        return { ok: false, reason: "session_calendar_response: bad holidays" };
      }
      if (!Array.isArray(obj.partialHolidays) || !obj.partialHolidays.every(isPartial)) {
        return { ok: false, reason: "session_calendar_response: bad partialHolidays" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "session_calendar_response",
          id: obj.id,
          holidays: obj.holidays,
          partialHolidays: obj.partialHolidays,
        },
      };
    }
    case "open_charts_response": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "open_charts_response: missing id" };
      }
      const isEntry = (v: unknown): v is OpenChartEntry => {
        if (!v || typeof v !== "object") return false;
        const e = v as Record<string, unknown>;
        return (
          typeof e.window === "string" &&
          typeof e.symbol === "string" &&
          typeof e.instrument === "string" &&
          typeof e.timeframe === "string" &&
          typeof e.isActive === "boolean" &&
          typeof e.hasRenderer === "boolean"
        );
      };
      if (!Array.isArray(obj.charts) || !obj.charts.every(isEntry)) {
        return { ok: false, reason: "open_charts_response: bad charts" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "open_charts_response",
          id: obj.id,
          charts: obj.charts as OpenChartEntry[],
          skippedWindows: typeof obj.skippedWindows === "number" ? obj.skippedWindows : 0,
        },
      };
    }
    case "subscribe_ack": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "subscribe_ack: missing id" };
      }
      if (typeof obj.symbol !== "string") {
        return { ok: false, reason: "subscribe_ack: missing symbol" };
      }
      if (typeof obj.timeframe !== "string") {
        return { ok: false, reason: "subscribe_ack: missing timeframe" };
      }
      if (typeof obj.contract !== "string") {
        return { ok: false, reason: "subscribe_ack: missing contract" };
      }
      if (typeof obj.seedCount !== "number") {
        return { ok: false, reason: "subscribe_ack: missing seedCount" };
      }
      if (typeof obj.seedLastTs !== "number") {
        return { ok: false, reason: "subscribe_ack: missing seedLastTs" };
      }
      if (typeof obj.alreadyActive !== "boolean") {
        return { ok: false, reason: "subscribe_ack: missing alreadyActive" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "subscribe_ack",
          id: obj.id,
          symbol: obj.symbol,
          timeframe: obj.timeframe,
          contract: obj.contract,
          seedCount: obj.seedCount,
          seedLastTs: obj.seedLastTs,
          alreadyActive: obj.alreadyActive,
        },
      };
    }
    case "unsubscribe_ack": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "unsubscribe_ack: missing id" };
      }
      if (typeof obj.symbol !== "string") {
        return { ok: false, reason: "unsubscribe_ack: missing symbol" };
      }
      if (typeof obj.timeframe !== "string") {
        return { ok: false, reason: "unsubscribe_ack: missing timeframe" };
      }
      if (typeof obj.removed !== "boolean") {
        return { ok: false, reason: "unsubscribe_ack: missing removed" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "unsubscribe_ack",
          id: obj.id,
          symbol: obj.symbol,
          timeframe: obj.timeframe,
          removed: obj.removed,
        },
      };
    }
    case "positions_response": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "positions_response: missing id" };
      }
      if (!Array.isArray(obj.accounts) || !obj.accounts.every(isAccountSnapshotPayload)) {
        return { ok: false, reason: "positions_response: bad accounts" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "positions_response",
          id: obj.id,
          accounts: obj.accounts as AccountSnapshotPayload[],
        },
      };
    }
    case "subscribe_positions_ack": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "subscribe_positions_ack: missing id" };
      }
      if (!Array.isArray(obj.accounts) || !obj.accounts.every((s) => typeof s === "string")) {
        return { ok: false, reason: "subscribe_positions_ack: accounts must be string[]" };
      }
      if (typeof obj.alreadyActive !== "boolean") {
        return { ok: false, reason: "subscribe_positions_ack: missing alreadyActive" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "subscribe_positions_ack",
          id: obj.id,
          accounts: obj.accounts as string[],
          alreadyActive: obj.alreadyActive,
        },
      };
    }
    case "unsubscribe_positions_ack": {
      if (typeof obj.id !== "string") {
        return { ok: false, reason: "unsubscribe_positions_ack: missing id" };
      }
      if (typeof obj.removed !== "boolean") {
        return { ok: false, reason: "unsubscribe_positions_ack: missing removed" };
      }
      return {
        ok: true,
        message: { v: 1, type: "unsubscribe_positions_ack", id: obj.id, removed: obj.removed },
      };
    }
    case "position_sync": {
      if (!Array.isArray(obj.accounts) || !obj.accounts.every(isAccountSnapshotPayload)) {
        return { ok: false, reason: "position_sync: bad accounts" };
      }
      if (!optNum(obj.seq) || !optNum(obj.ts) || !optStr(obj.reason)) {
        return { ok: false, reason: "position_sync: bad seq/ts/reason" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "position_sync",
          accounts: obj.accounts as AccountSnapshotPayload[],
          ...(typeof obj.seq === "number" ? { seq: obj.seq } : {}),
          ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
          ...(typeof obj.ts === "number" ? { ts: obj.ts } : {}),
        },
      };
    }
    case "position_event": {
      if (typeof obj.account !== "string") {
        return { ok: false, reason: "position_event: missing account" };
      }
      if (obj.kind !== "position" && obj.kind !== "order" && obj.kind !== "execution") {
        return { ok: false, reason: `position_event: bad kind ${String(obj.kind)}` };
      }
      if (!optNum(obj.seq) || !optNum(obj.ts) || !optStr(obj.operation)) {
        return { ok: false, reason: "position_event: bad seq/ts/operation" };
      }
      if (obj.kind === "position" && !isPositionPayload(obj.position)) {
        return { ok: false, reason: "position_event: invalid position payload" };
      }
      if (obj.kind === "order" && !isWorkingOrderPayload(obj.order)) {
        return { ok: false, reason: "position_event: invalid order payload" };
      }
      if (obj.kind === "execution" && !isExecutionPayload(obj.execution)) {
        return { ok: false, reason: "position_event: invalid execution payload" };
      }
      return {
        ok: true,
        message: {
          v: 1,
          type: "position_event",
          account: obj.account,
          kind: obj.kind,
          ...(typeof obj.seq === "number" ? { seq: obj.seq } : {}),
          ...(typeof obj.ts === "number" ? { ts: obj.ts } : {}),
          ...(obj.kind === "position" ? { position: obj.position as PositionPayload } : {}),
          ...(obj.kind === "order" ? { order: obj.order as WorkingOrderPayload } : {}),
          ...(obj.kind === "execution"
            ? { execution: obj.execution as ExecutionPayload }
            : {}),
          ...(typeof obj.operation === "string" ? { operation: obj.operation } : {}),
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
