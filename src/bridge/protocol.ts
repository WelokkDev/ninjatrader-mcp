import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// Each message shape is defined once as a zod schema; the TS types are z.infer
// of them. The C# AddOn (ninja-addon/addons/mcp-bridge.cs) mirrors these shapes
// by hand. Parsing strips unknown keys, rejects missing/wrong-typed/non-finite
// fields, and keeps absent optionals absent.

/** Envelope for unsolicited messages. */
function msg<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ v: z.literal(1), type: z.literal(type), ...shape });
}

/** Envelope for request/response messages correlated by id. */
function reqMsg<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ v: z.literal(1), id: z.string(), type: z.literal(type), ...shape });
}

export const helloMessageSchema = msg("hello", {
  ntVersion: z.string(),
  instruments: z.array(z.string()),
  // NT8-configured timezone id (bars are stamped in it); older AddOns omit it.
  timeZone: z.string().optional(),
});
export type HelloMessage = z.infer<typeof helloMessageSchema>;

export const instrumentsUpdateMessageSchema = msg("instruments_update", {
  instruments: z.array(z.string()),
});
export type InstrumentsUpdateMessage = z.infer<typeof instrumentsUpdateMessageSchema>;

export const heartbeatMessageSchema = msg("heartbeat", {});
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;

export const helloAckMessageSchema = msg("hello_ack", {
  serverVersion: z.string(),
});
export type HelloAckMessage = z.infer<typeof helloAckMessageSchema>;

/** Shared with the draw_zone MCP tool's params (draw-zone.ts). */
export const drawZoneFields = {
  id: z.string().min(1),
  symbol: z.string().min(1),
  proximal: z.number(),
  distal: z.number(),
  // Unix seconds; omit fromTs for the bars-back fallback anchor, toTs to
  // extend to the current bar.
  fromTs: z.number().int().optional(),
  toTs: z.number().int().optional(),
};
export const drawZoneMessageSchema = msg("draw_zone", drawZoneFields);
export type DrawZoneMessage = z.infer<typeof drawZoneMessageSchema>;

export const drawStyleSchema = z.object({
  color: z.string().optional(), // "#rrggbb"
  opacity: z.number().min(0).max(1).optional(), // 0..1 fill opacity (rectangles)
  label: z.string().optional(), // companion text at the shape's anchor
});
export type DrawStyle = z.infer<typeof drawStyleSchema>;

/** Chart primitives; timestamps are unix seconds (draw_zone ET convention). */
export const drawShapeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rectangle"),
    proximal: z.number(),
    distal: z.number(),
    fromTs: z.number().int().optional(),
    toTs: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("hline"),
    price: z.number(),
    fromTs: z.number().int().optional(),
    toTs: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("vline"), ts: z.number().int() }),
  z.object({
    kind: z.literal("text"),
    ts: z.number().int(),
    price: z.number(),
    text: z.string().min(1),
  }),
]);
export type DrawShape = z.infer<typeof drawShapeSchema>;

export const drawMessageSchema = msg("draw", {
  id: z.string().min(1),
  symbol: z.string().min(1),
  shape: drawShapeSchema,
  style: drawStyleSchema.optional(),
});
export type DrawMessage = z.infer<typeof drawMessageSchema>;

export const clearZonesMessageSchema = msg("clear_zones", {
  // Omit symbol to clear every renderer-attached chart.
  symbol: z.string().optional(),
  // Legacy single-id form; prefer `ids`.
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
});
export type ClearZonesMessage = z.infer<typeof clearZonesMessageSchema>;

export const requestCandlesMessageSchema = reqMsg("request_candles", {
  symbol: z.string(),
  timeframe: z.string(),
  from: z.number(),
  to: z.number(),
  // Session-template name (e.g. "cme_us_index_futures_eth"); the AddOn fails
  // the request closed on a missing/unknown template.
  tradingHoursTemplate: z.string(),
});
export type RequestCandlesMessage = z.infer<typeof requestCandlesMessageSchema>;

export const candlePayloadSchema = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});
export type CandlePayload = z.infer<typeof candlePayloadSchema>;

export const candlesResponseMessageSchema = reqMsg("candles_response", {
  symbol: z.string(),
  timeframe: z.string(),
  candles: z.array(candlePayloadSchema),
});
export type CandlesResponseMessage = z.infer<typeof candlesResponseMessageSchema>;

export const barCloseMessageSchema = msg("bar_close", {
  symbol: z.string(),
  timeframe: z.string(),
  candle: candlePayloadSchema,
  // Monotonic per subscription; a jump = undelivered bars, a reset = re-seed.
  seq: z.number().optional(),
  // Resolved NT8 contract (e.g. "MNQ 09-26") — makes rolls visible.
  contract: z.string().optional(),
  // Closed well before emission; act-on-close consumers skip these.
  backfill: z.boolean().optional(),
});
export type BarCloseMessage = z.infer<typeof barCloseMessageSchema>;

export const subscribeBarsMessageSchema = reqMsg("subscribe_bars", {
  symbol: z.string(),
  timeframe: z.string(),
  // Same fail-closed template contract as request_candles.
  tradingHoursTemplate: z.string(),
});
export type SubscribeBarsMessage = z.infer<typeof subscribeBarsMessageSchema>;

export const unsubscribeBarsMessageSchema = reqMsg("unsubscribe_bars", {
  symbol: z.string(),
  timeframe: z.string(),
});
export type UnsubscribeBarsMessage = z.infer<typeof unsubscribeBarsMessageSchema>;

export const subscribeAckMessageSchema = reqMsg("subscribe_ack", {
  symbol: z.string(),
  timeframe: z.string(),
  // Resolved NT8 contract FullName the stream is bound to.
  contract: z.string(),
  // Bars in the C# seed request; 0 on an alreadyActive re-subscribe.
  seedCount: z.number(),
  // Unix seconds of the last seeded bar; 0 when none.
  seedLastTs: z.number(),
  // The subscription already existed C#-side.
  alreadyActive: z.boolean(),
});
export type SubscribeAckMessage = z.infer<typeof subscribeAckMessageSchema>;

export const unsubscribeAckMessageSchema = reqMsg("unsubscribe_ack", {
  symbol: z.string(),
  timeframe: z.string(),
  removed: z.boolean(),
});
export type UnsubscribeAckMessage = z.infer<typeof unsubscribeAckMessageSchema>;

export const requestSessionCalendarMessageSchema = reqMsg("request_session_calendar", {
  tradingHoursTemplate: z.string(),
});
export type RequestSessionCalendarMessage = z.infer<typeof requestSessionCalendarMessageSchema>;

export const sessionCalendarResponseMessageSchema = reqMsg("session_calendar_response", {
  // NT8 TradingHours.Holidays — fully-closed dates (YYYY-MM-DD).
  holidays: z.array(z.object({ date: z.string(), description: z.string() })),
  // NT8 TradingHours.PartialHolidays — dates only; NT8 exposes no times.
  partialHolidays: z.array(
    z.object({
      date: z.string(),
      isEarlyClose: z.boolean(),
      isLateBegin: z.boolean(),
      description: z.string(),
    }),
  ),
});
export type SessionCalendarResponseMessage = z.infer<typeof sessionCalendarResponseMessageSchema>;

export const requestOpenChartsMessageSchema = reqMsg("request_open_charts", {});
export type RequestOpenChartsMessage = z.infer<typeof requestOpenChartsMessageSchema>;

/** One open chart tab. `timeframe` is compact ("5m") when the bars type maps
 *  to SUPPORTED_TIMEFRAMES, else NT8's display string ("150 Tick"); empty
 *  strings mean the tab hadn't finished loading. */
export const openChartEntrySchema = z.object({
  window: z.string(),
  symbol: z.string(),
  instrument: z.string(),
  timeframe: z.string(),
  isActive: z.boolean(),
  hasRenderer: z.boolean(),
});
export type OpenChartEntry = z.infer<typeof openChartEntrySchema>;

export const openChartsResponseMessageSchema = reqMsg("open_charts_response", {
  charts: z.array(openChartEntrySchema),
  skippedWindows: z.number().default(0),
});
export type OpenChartsResponseMessage = z.infer<typeof openChartsResponseMessageSchema>;

// ---------- live position tracking (read-only) ----------
// Enum-ish fields carry NT8's own ToString() values so new values pass through.

export const positionPayloadSchema = z.object({
  instrument: z.string(), // resolved contract, e.g. "MNQ 09-26"
  symbol: z.string(), // master symbol, e.g. "MNQ" (roster/draw convention)
  marketPosition: z.string(),
  quantity: z.number(),
  averagePrice: z.number().optional(),
  pointValue: z.number().optional(),
  tickSize: z.number().optional(),
  // Best-effort from NT8 market data; omitted when no data is flowing.
  unrealizedPnl: z.number().optional(),
  marketPrice: z.number().optional(),
  marketPriceTs: z.number().optional(),
});
export type PositionPayload = z.infer<typeof positionPayloadSchema>;

export const workingOrderPayloadSchema = z.object({
  orderId: z.string(),
  name: z.string(), // NT8 order name, e.g. "Stop loss" / "Profit target"
  instrument: z.string(),
  symbol: z.string(),
  action: z.string(),
  orderType: z.string(),
  state: z.string(),
  quantity: z.number(),
  filled: z.number(),
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
  avgFillPrice: z.number().optional(),
  time: z.number().optional(), // unix seconds
  oco: z.string().optional(),
});
export type WorkingOrderPayload = z.infer<typeof workingOrderPayloadSchema>;

export const executionPayloadSchema = z.object({
  executionId: z.string(),
  orderId: z.string(),
  instrument: z.string(),
  symbol: z.string(),
  side: z.string(), // NT8 MarketPosition of the fill: "Long" = buy, "Short" = sell
  quantity: z.number(),
  price: z.number().optional(),
  time: z.number().optional(), // unix seconds
  orderName: z.string().optional(),
  commission: z.number().optional(),
});
export type ExecutionPayload = z.infer<typeof executionPayloadSchema>;

export const accountSnapshotPayloadSchema = z.object({
  name: z.string(),
  connection: z.string().optional(),
  connectionStatus: z.string().optional(),
  denomination: z.string().optional(),
  realizedPnl: z.number().optional(),
  cashValue: z.number().optional(),
  netLiquidation: z.number().optional(),
  positions: z.array(positionPayloadSchema),
  orders: z.array(workingOrderPayloadSchema), // working (non-terminal) orders only
});
export type AccountSnapshotPayload = z.infer<typeof accountSnapshotPayloadSchema>;

export const requestPositionsMessageSchema = reqMsg("request_positions", {});
export type RequestPositionsMessage = z.infer<typeof requestPositionsMessageSchema>;

export const positionsResponseMessageSchema = reqMsg("positions_response", {
  accounts: z.array(accountSnapshotPayloadSchema),
});
export type PositionsResponseMessage = z.infer<typeof positionsResponseMessageSchema>;

export const subscribePositionsMessageSchema = reqMsg("subscribe_positions", {});
export type SubscribePositionsMessage = z.infer<typeof subscribePositionsMessageSchema>;

export const subscribePositionsAckMessageSchema = reqMsg("subscribe_positions_ack", {
  accounts: z.array(z.string()),
  alreadyActive: z.boolean(),
});
export type SubscribePositionsAckMessage = z.infer<typeof subscribePositionsAckMessageSchema>;

export const unsubscribePositionsMessageSchema = reqMsg("unsubscribe_positions", {});
export type UnsubscribePositionsMessage = z.infer<typeof unsubscribePositionsMessageSchema>;

export const unsubscribePositionsAckMessageSchema = reqMsg("unsubscribe_positions_ack", {
  removed: z.boolean(),
});
export type UnsubscribePositionsAckMessage = z.infer<typeof unsubscribePositionsAckMessageSchema>;

/** Unsolicited full snapshot (subscribe / reconnect / roster change); shares
 *  the position_event seq stream. */
export const positionSyncMessageSchema = msg("position_sync", {
  accounts: z.array(accountSnapshotPayloadSchema),
  seq: z.number().optional(),
  reason: z.string().optional(),
  ts: z.number().optional(), // unix seconds at emit
});
export type PositionSyncMessage = z.infer<typeof positionSyncMessageSchema>;

export const positionEventMessageSchema = msg("position_event", {
  account: z.string(),
  kind: z.enum(["position", "order", "execution"]),
  seq: z.number().optional(),
  ts: z.number().optional(), // unix seconds at emit
  // Exactly one of these is present, matching `kind`.
  position: positionPayloadSchema.optional(),
  order: workingOrderPayloadSchema.optional(),
  execution: executionPayloadSchema.optional(),
  // kind="position" only: NT8 Operation (Add | Update | Remove).
  operation: z.string().optional(),
}).superRefine((data, ctx) => {
  // Only the payload named by `kind` is required; extras pass through.
  if (data[data.kind] === undefined) {
    ctx.addIssue({
      code: "custom",
      path: [data.kind],
      message: `missing ${data.kind} payload for kind=${data.kind}`,
    });
  }
});
export type PositionEventMessage = z.infer<typeof positionEventMessageSchema>;

// ---------- order placement (write path) ----------
// Fields are shared with the place_order tool's params so the wire and tool
// surfaces never drift. Cross-field rules (a Limit needs limitPrice) live in
// the ExecutionService. clientOrderId is the idempotency key — it rides
// through as the NT8 order Name and the C# side dedupes retries on it.

export const ORDER_ACTIONS = ["Buy", "Sell"] as const;
export const ORDER_TYPES = ["Market", "Limit", "Stop", "StopLimit"] as const;
export const ORDER_TIFS = ["Day", "Gtc"] as const;

export const placeOrderFields = {
  account: z.string().min(1),
  symbol: z.string().min(1),
  action: z.enum(ORDER_ACTIONS),
  orderType: z.enum(ORDER_TYPES),
  quantity: z.number().int().positive(),
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
  tif: z.enum(ORDER_TIFS),
  clientOrderId: z.string().min(1).max(50),
};
export const placeOrderMessageSchema = reqMsg("place_order", placeOrderFields);
export type PlaceOrderMessage = z.infer<typeof placeOrderMessageSchema>;

/** Synchronous accept of a submit call — NOT a fill and NOT a broker accept.
 *  The order then transitions asynchronously (Accepted → Working → Filled, or
 *  → Rejected) via the position_event order stream. `orderId` may be absent
 *  until NT8 assigns one; correlate on `clientOrderId` (the order Name). */
export const orderAckMessageSchema = reqMsg("order_ack", {
  clientOrderId: z.string(),
  contract: z.string(), // resolved NT8 contract, e.g. "MNQ 09-26"
  orderId: z.string().optional(),
  state: z.string(), // initial NT8 OrderState, e.g. "Submitted"
  // The C# gate/dedup short-circuited without a fresh Submit (idempotent replay).
  deduped: z.boolean().optional(),
});
export type OrderAckMessage = z.infer<typeof orderAckMessageSchema>;

export const errorMessageSchema = reqMsg("error", {
  message: z.string(),
  // Optional machine-readable classifier for order rejections. The C# AddOn
  // sets it on every place_order rejection (see HandlePlaceOrder); older AddOns
  // and non-order rejections omit it, so consumers must tolerate its absence.
  code: z.string().optional(),
});
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

// Registering here both admits a type to parseMessage and adds it to InboundMessage.
const INBOUND_SCHEMAS = {
  hello: helloMessageSchema,
  heartbeat: heartbeatMessageSchema,
  instruments_update: instrumentsUpdateMessageSchema,
  candles_response: candlesResponseMessageSchema,
  bar_close: barCloseMessageSchema,
  session_calendar_response: sessionCalendarResponseMessageSchema,
  open_charts_response: openChartsResponseMessageSchema,
  subscribe_ack: subscribeAckMessageSchema,
  unsubscribe_ack: unsubscribeAckMessageSchema,
  positions_response: positionsResponseMessageSchema,
  subscribe_positions_ack: subscribePositionsAckMessageSchema,
  unsubscribe_positions_ack: unsubscribePositionsAckMessageSchema,
  position_sync: positionSyncMessageSchema,
  position_event: positionEventMessageSchema,
  order_ack: orderAckMessageSchema,
  error: errorMessageSchema,
};

export type InboundMessage = z.infer<(typeof INBOUND_SCHEMAS)[keyof typeof INBOUND_SCHEMAS]>;
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
  | UnsubscribePositionsMessage
  | PlaceOrderMessage;
export type AnyMessage = InboundMessage | OutboundMessage;

export type ParseResult =
  | { ok: true; message: AnyMessage }
  | { ok: false; reason: string };

function issueReason(type: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return `${type}: invalid`;
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${type}: ${path}${issue.message}`;
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
  // hasOwn: inherited keys like "constructor" are unknown types, not prototype hits.
  if (!Object.hasOwn(INBOUND_SCHEMAS, obj.type)) {
    return { ok: false, reason: `unknown type: ${obj.type}` };
  }
  const result = INBOUND_SCHEMAS[obj.type as keyof typeof INBOUND_SCHEMAS].safeParse(obj);
  if (!result.success) {
    return { ok: false, reason: issueReason(obj.type, result.error) };
  }
  return { ok: true, message: result.data };
}

export function encode(message: OutboundMessage): string {
  return JSON.stringify(message);
}
