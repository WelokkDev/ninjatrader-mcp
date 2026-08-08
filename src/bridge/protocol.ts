import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// Schemas are the single source; TS types are z.infer. The C# AddOn
// (ninja-addon/addons/mcp-bridge.cs) mirrors these shapes by hand.

function msg<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ v: z.literal(1), type: z.literal(type), ...shape });
}

/** Request/response envelope correlated by id. */
function reqMsg<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ v: z.literal(1), id: z.string(), type: z.literal(type), ...shape });
}

export const helloMessageSchema = msg("hello", {
  ntVersion: z.string(),
  instruments: z.array(z.string()),
  // NT8-configured timezone id (bars are stamped in it); older AddOns omit it.
  timeZone: z.string().optional(),
  // Write ops this AddOn supports; absent = old AddOn (place_order only), so
  // ExecutionService fails fast on unsupported ops rather than timing out (deploy skew).
  caps: z.array(z.string()).optional(),
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

/**
 * Legacy zone-rectangle wire message. The `draw_zone` MCP *tool* was removed
 * 2026-07-27 (superseded by the generic `draw` tool), but this message type
 * stays: scan_zones' `draw:true` path and the NT8 AddOn still speak it.
 */
export const drawZoneFields = {
  id: z.string().min(1),
  symbol: z.string().min(1),
  proximal: z.number(),
  distal: z.number(),
  // Unix seconds; omit fromTs for the bars-back anchor, toTs to extend to current bar.
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
  // Mirrors NT8's Draw.RiskReward: entry + one leg + ratio, third leg derived.
  // Field names match riskRewardPayloadSchema, so a get_drawings read round-trips.
  // toJSONSchema drops the refine below, so draw's tool description has to state
  // the stop-XOR-target rule in prose as well.
  z
    .object({
      kind: z.literal("riskreward"),
      entry: z.number(),
      stop: z.number().optional(),
      target: z.number().optional(),
      ratio: z.number().positive(),
      fromTs: z.number().int().optional(),
      toTs: z.number().int().optional(),
    })
    .superRefine((s, ctx) => {
      const hasStop = s.stop !== undefined;
      const hasTarget = s.target !== undefined;
      if (hasStop === hasTarget) {
        ctx.addIssue({
          code: "custom",
          message:
            "riskreward: provide exactly one of stop or target — the other leg is derived from ratio",
        });
        return;
      }
      // A zero-length leg collapses the whole drawing to one line at entry.
      const leg = hasStop ? s.stop : s.target;
      if (leg === s.entry) {
        ctx.addIssue({
          code: "custom",
          message: `riskreward: ${hasStop ? "stop" : "target"} must differ from entry`,
        });
      }
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
  id: z.string().optional(), // legacy single-id form; prefer `ids`
  ids: z.array(z.string()).optional(),
});
export type ClearZonesMessage = z.infer<typeof clearZonesMessageSchema>;

export const requestCandlesMessageSchema = reqMsg("request_candles", {
  symbol: z.string(),
  timeframe: z.string(),
  from: z.number(),
  to: z.number(),
  // Session-template name; AddOn fails the request closed on a missing/unknown template.
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
  // NT8 feed that served this fetch; older AddOns omit. Ingest rejects sim-feed bars (data-source.ts).
  dataSource: z.string().optional(),
});
export type CandlesResponseMessage = z.infer<typeof candlesResponseMessageSchema>;

export const barCloseMessageSchema = msg("bar_close", {
  symbol: z.string(),
  timeframe: z.string(),
  candle: candlePayloadSchema,
  // Monotonic per subscription; a jump = undelivered bars, a reset = re-seed.
  seq: z.number().optional(),
  contract: z.string().optional(), // resolved NT8 contract (e.g. "MNQ 09-26"); makes rolls visible
  dataSource: z.string().optional(), // feed; sim-feed bars rejected on ingest
  backfill: z.boolean().optional(), // closed well before emission; act-on-close consumers skip these
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
  contract: z.string(), // resolved NT8 contract FullName the stream is bound to
  seedCount: z.number(), // bars in the C# seed request; 0 on an alreadyActive re-subscribe
  seedLastTs: z.number(), // unix seconds of the last seeded bar; 0 when none
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

/** One open chart tab. `timeframe` is compact ("5m") when mappable to
 *  SUPPORTED_TIMEFRAMES, else NT8's display string ("150 Tick"); empty = tab still loading. */
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

/** Scroll charts of `symbol` to `ts` (unix seconds) and/or zoom to `barsOnScreen`; at least one required. */
export const navigateChartMessageSchema = reqMsg("navigate_chart", {
  symbol: z.string().min(1),
  ts: z.number().int().optional(),
  timeframe: z.string().optional(), // tab filter, compact form ("5m")
  barsOnScreen: z.number().int().optional(),
  align: z.enum(["center", "right"]).optional(), // default center
  activate: z.boolean().optional(), // default true: select tab + focus window
});
export type NavigateChartMessage = z.infer<typeof navigateChartMessageSchema>;

/** Per-matched-tab outcome; times are unix seconds. `clamped` = target fell
 *  outside loaded bars (fix: more Days To Load in NT8). */
export const navigateChartResultSchema = z.object({
  window: z.string(),
  symbol: z.string(),
  timeframe: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  method: z.string().optional(), // "slot" | "scrollToTime" (TimeBased fallback)
  clamped: z.boolean().optional(),
  firstLoadedTs: z.number().optional(),
  lastLoadedTs: z.number().optional(),
  visibleFromTs: z.number().optional(),
  visibleToTs: z.number().optional(),
  activated: z.boolean().optional(),
});
export type NavigateChartResult = z.infer<typeof navigateChartResultSchema>;

export const navigateChartAckMessageSchema = reqMsg("navigate_chart_ack", {
  results: z.array(navigateChartResultSchema),
  matched: z.number(),
  skippedWindows: z.number().default(0),
});
export type NavigateChartAckMessage = z.infer<typeof navigateChartAckMessageSchema>;

// ---------- drawing-tool read-back (read-only) ----------
// Reads NT8 drawing objects off open charts, including hand-drawn ones.
// `toolType` is the tool's concrete GetType().Name ("RiskReward", "Ray", ...);
// Risk/Reward tools carry parsed geometry (riskReward below).

export const requestDrawingsMessageSchema = reqMsg("request_drawings", {
  symbol: z.string().optional(), // only charts of this master symbol ("MNQ")
  toolType: z.string().optional(), // only this concrete tool, e.g. "RiskReward"
  userDrawnOnly: z.boolean().optional(), // drop NinjaScript-drawn objects (incl. our own mcp_ draws)
});
export type RequestDrawingsMessage = z.infer<typeof requestDrawingsMessageSchema>;

/** ts (unix seconds, ET) is best-effort — omitted when the time won't convert. */
export const drawingAnchorSchema = z.object({
  price: z.number(),
  ts: z.number().optional(),
});
export type DrawingAnchor = z.infer<typeof drawingAnchorSchema>;

/** Parsed from a RiskReward tool's anchors [entry, stop (RiskAnchor),
 *  target (RewardAnchor)]. `ratio` is NT8's stored value (best-effort);
 *  computedRatio is rewardPoints/riskPoints from the anchor prices. */
export const riskRewardPayloadSchema = z.object({
  entry: z.number(),
  stop: z.number(),
  target: z.number(),
  direction: z.enum(["long", "short", "flat"]),
  riskPoints: z.number(),
  rewardPoints: z.number(),
  computedRatio: z.number().optional(),
  ratio: z.number().optional(),
});
export type RiskRewardPayload = z.infer<typeof riskRewardPayloadSchema>;

export const drawingEntrySchema = z.object({
  window: z.string(),
  symbol: z.string(),
  timeframe: z.string(),
  tag: z.string(),
  toolType: z.string(), // concrete NT8 type name (GetType().Name)
  isUserDrawn: z.boolean(),
  isVisible: z.boolean(),
  text: z.string().optional(), // Text-tool content / label, when the tool exposes one
  anchors: z.array(drawingAnchorSchema),
  riskReward: riskRewardPayloadSchema.optional(), // present only for RiskReward tools
});
export type DrawingEntry = z.infer<typeof drawingEntrySchema>;

export const drawingsResponseMessageSchema = reqMsg("drawings_response", {
  drawings: z.array(drawingEntrySchema),
  skippedWindows: z.number().default(0),
});
export type DrawingsResponseMessage = z.infer<typeof drawingsResponseMessageSchema>;

// ---------- chart indicator read-back (read-only) ----------
// Split by call frequency: request_chart_indicators discovers what is attached
// to each chart (rare); request_indicator_values then polls ONE indicator's
// plot values by handle (cheap, repeatable). Neither mutates a chart.

export const requestChartIndicatorsMessageSchema = reqMsg("request_chart_indicators", {
  symbol: z.string().optional(), // master symbol as in list_open_charts ("MNQ")
  timeframe: z.string().optional(), // compact form ("5m")
});
export type RequestChartIndicatorsMessage = z.infer<typeof requestChartIndicatorsMessageSchema>;

/** `name` is the NT8 property name (what `match.params` keys on), `label` its
 *  localized UI label. Only the indicator's own settings appear — the ~10 every
 *  NinjaScript inherits (Calculate, Panel, IsVisible, …) are chart plumbing. */
export const indicatorParamSchema = z.object({
  name: z.string(),
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type IndicatorParam = z.infer<typeof indicatorParamSchema>;

/** Styling only; values come from request_indicator_values. `color` is null
 *  when the brush isn't a solid color (e.g. a gradient). */
export const indicatorPlotStyleSchema = z.object({
  name: z.string(),
  color: z.string().nullable().optional(), // "#FFFFA500"
  style: z.string().optional(), // NT8 PlotStyle, e.g. "Line"
});
export type IndicatorPlotStyle = z.infer<typeof indicatorPlotStyleSchema>;

/** `id` is NT8's IndicatorId — the handle request_indicator_values takes. Stable
 *  within a session, but a chart reload / timeframe switch recreates indicators,
 *  so a stale id reads back found:false and the caller re-discovers. */
export const chartIndicatorSchema = z.object({
  id: z.number().int(),
  name: z.string(), // full type name, "NinjaTrader.NinjaScript.Indicators.SMA"
  displayName: z.string(), // "SMA(20)"
  panel: z.number().int(), // NT8's raw value; -1 = price panel
  isOverlay: z.boolean(),
  displacement: z.number().int(), // plot shift; values are NOT compensated for it
  // Value-retention setting ("TwoHundredFiftySix" | "Infinite" | "unknown"),
  // which bounds how far back values read — NOT how far the chart loaded.
  readableDepth: z.string(),
  params: z.array(indicatorParamSchema),
  plots: z.array(indicatorPlotStyleSchema),
});
export type ChartIndicator = z.infer<typeof chartIndicatorSchema>;

export const chartIndicatorsEntrySchema = z.object({
  window: z.string(),
  symbol: z.string(),
  instrument: z.string(),
  timeframe: z.string(),
  isActive: z.boolean(),
  indicators: z.array(chartIndicatorSchema),
});
export type ChartIndicatorsEntry = z.infer<typeof chartIndicatorsEntrySchema>;

export const chartIndicatorsResponseMessageSchema = reqMsg("chart_indicators_response", {
  charts: z.array(chartIndicatorsEntrySchema),
  skippedWindows: z.number().default(0),
});
export type ChartIndicatorsResponseMessage = z.infer<typeof chartIndicatorsResponseMessageSchema>;

/** Fallback selector when the caller holds no `id`: NT8 type name (short "SMA"
 *  or full) plus enough params to disambiguate ({Period: 20}). */
export const indicatorMatchSchema = z.object({
  name: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type IndicatorMatch = z.infer<typeof indicatorMatchSchema>;

/** Exactly one of {indicatorId, match} selects the indicator; the range is
 *  either from/to (unix seconds, either end optional) or bars (last N).
 *  Cross-field rules live in the handler, per placeOrderFields. `indicatorId`
 *  not `id`: the envelope's `id` is the correlation uuid and a same-named
 *  payload key would clobber it. */
export const requestIndicatorValuesMessageSchema = reqMsg("request_indicator_values", {
  symbol: z.string(),
  timeframe: z.string().optional(),
  indicatorId: z.number().int().optional(),
  match: indicatorMatchSchema.optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  bars: z.number().int().min(1).optional(),
});
export type RequestIndicatorValuesMessage = z.infer<typeof requestIndicatorValuesMessageSchema>;

/** `t` is unix seconds on the get_candles convention, so points line up 1:1
 *  with candles. */
export const indicatorValuePointSchema = z.object({
  t: z.number().int(),
  v: z.number(),
});
export type IndicatorValuePoint = z.infer<typeof indicatorValuePointSchema>;

/** availableFrom/To are the first/last timestamps this plot could actually serve
 *  inside the requested window (null = nothing valid); narrower than requested
 *  means the instance's retention wall, not missing chart data. `truncated` =
 *  the window exceeded the AddOn's per-plot cap and the oldest points went. */
export const indicatorValuePlotSchema = z.object({
  name: z.string(),
  values: z.array(indicatorValuePointSchema),
  availableFrom: z.number().int().nullable(),
  availableTo: z.number().int().nullable(),
  truncated: z.boolean(),
});
export type IndicatorValuePlot = z.infer<typeof indicatorValuePlotSchema>;

/** found:false is a normal outcome (stale handle / no matching chart), not an
 *  error — `reason` says which. The resolved indicatorId hands a match-based read
 *  a handle for the next poll; barsFrom/barsTo report the chart's loaded window,
 *  so comparing it with a plot's availableFrom exposes the retention wall. */
export const indicatorValuesResponseMessageSchema = reqMsg("indicator_values_response", {
  found: z.boolean(),
  reason: z.string().optional(),
  symbol: z.string().optional(),
  timeframe: z.string().optional(),
  window: z.string().optional(),
  indicatorId: z.number().int().optional(),
  displayName: z.string().optional(),
  matchCount: z.number().int().optional(), // >1 = the selector was ambiguous
  displacement: z.number().int().optional(),
  barCount: z.number().int().optional(),
  barsFrom: z.number().int().nullable().optional(),
  barsTo: z.number().int().nullable().optional(),
  plots: z.array(indicatorValuePlotSchema).default([]),
});
export type IndicatorValuesResponseMessage = z.infer<typeof indicatorValuesResponseMessageSchema>;

// Live position tracking (read-only). Enum-ish fields carry NT8's own
// ToString() values so new values pass through.

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
  operation: z.string().optional(), // kind="position" only: NT8 Operation (Add|Update|Remove)
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

// Order placement (write path). Fields are single-sourced with the place_order
// tool params so wire and tool can't drift; cross-field rules (Limit needs
// limitPrice) live in ExecutionService. clientOrderId is the idempotency key:
// rides through as the NT8 order Name, C# dedupes retries on it.

export const ORDER_ACTIONS = ["Buy", "Sell"] as const;
export const ORDER_TYPES = ["Market", "Limit", "Stop", "StopLimit"] as const;
// NT8's TimeInForce has NO FOK (verified by reflection: Day/Gtc/Ioc/Opg/Gtd); we don't emulate it.
export const ORDER_TIFS = ["Day", "Gtc", "Ioc"] as const;

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

/** Synchronous accept of a submit call — NOT a fill/broker accept. Order then
 *  transitions async (Accepted → Working → Filled | Rejected) via the position_event
 *  order stream. `orderId` may be absent until NT8 assigns one; correlate on `clientOrderId`. */
export const orderAckMessageSchema = reqMsg("order_ack", {
  clientOrderId: z.string(),
  contract: z.string(), // resolved NT8 contract, e.g. "MNQ 09-26"
  orderId: z.string().optional(),
  state: z.string(), // initial NT8 OrderState, e.g. "Submitted"
  // C# gate/dedup short-circuited without a fresh Submit (idempotent replay).
  deduped: z.boolean().optional(),
  // EFFECTIVE prices used (tick-rounded C#-side); older AddOns omit.
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
});
export type OrderAckMessage = z.infer<typeof orderAckMessageSchema>;

// Order management (phase 2 write path). Same single-sourcing rule as
// placeOrderFields; cross-field rules (change needs ≥1 field; oco leg-id
// derivation) live in ExecutionService.

export const cancelOrderFields = {
  account: z.string().min(1),
  clientOrderId: z.string().min(1).max(50),
};
export const cancelOrderMessageSchema = reqMsg("cancel_order", cancelOrderFields);
export type CancelOrderMessage = z.infer<typeof cancelOrderMessageSchema>;

export const cancelAllFields = {
  account: z.string().min(1),
  symbol: z.string().min(1),
};
export const cancelAllMessageSchema = reqMsg("cancel_all", cancelAllFields);
export type CancelAllMessage = z.infer<typeof cancelAllMessageSchema>;

export const flattenFields = {
  account: z.string().min(1),
  symbol: z.string().min(1),
};
export const flattenMessageSchema = reqMsg("flatten", flattenFields);
export type FlattenMessage = z.infer<typeof flattenMessageSchema>;

export const changeOrderFields = {
  account: z.string().min(1),
  clientOrderId: z.string().min(1).max(50),
  quantity: z.number().int().positive().optional(),
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
};
export const changeOrderMessageSchema = reqMsg("change_order", changeOrderFields);
export type ChangeOrderMessage = z.infer<typeof changeOrderMessageSchema>;

/** Exit pair only: protective StopMarket + Limit target sharing action/qty/tif,
 *  submitted in ONE Account.Submit so NT8 links them via `ocoId`. Leg names are
 *  the leg clientOrderIds (dedupe keys). */
export const placeOcoFields = {
  account: z.string().min(1),
  symbol: z.string().min(1),
  action: z.enum(ORDER_ACTIONS),
  quantity: z.number().int().positive(),
  stopPrice: z.number(),
  limitPrice: z.number(),
  tif: z.enum(ORDER_TIFS),
  ocoId: z.string().min(1),
  stopClientOrderId: z.string().min(1).max(50),
  targetClientOrderId: z.string().min(1).max(50),
};
export const placeOcoMessageSchema = reqMsg("place_oco", placeOcoFields);
export type PlaceOcoMessage = z.infer<typeof placeOcoMessageSchema>;

export const cancelAckMessageSchema = reqMsg("cancel_ack", {
  clientOrderId: z.string(),
  orderId: z.string().optional(),
  state: z.string(), // post-Cancel() NT8 OrderState, e.g. "CancelSubmitted"
});
export type CancelAckMessage = z.infer<typeof cancelAckMessageSchema>;

export const cancelAllAckMessageSchema = reqMsg("cancel_all_ack", {
  contract: z.string(),
  // Working orders counted just before CancelAllOrders — informational only.
  cancelledCount: z.number().optional(),
});
export type CancelAllAckMessage = z.infer<typeof cancelAllAckMessageSchema>;

export const flattenAckMessageSchema = reqMsg("flatten_ack", {
  contract: z.string(),
});
export type FlattenAckMessage = z.infer<typeof flattenAckMessageSchema>;

export const changeAckMessageSchema = reqMsg("change_ack", {
  clientOrderId: z.string(),
  orderId: z.string().optional(),
  state: z.string(), // post-Change() NT8 OrderState, e.g. "ChangeSubmitted"
  // EFFECTIVE post-rounding values the change was staged with.
  quantity: z.number().optional(),
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
});
export type ChangeAckMessage = z.infer<typeof changeAckMessageSchema>;

export const ocoLegAckSchema = z.object({
  clientOrderId: z.string(),
  orderId: z.string().optional(),
  state: z.string(),
});
export type OcoLegAck = z.infer<typeof ocoLegAckSchema>;

export const ocoAckMessageSchema = reqMsg("oco_ack", {
  ocoId: z.string(),
  contract: z.string(),
  stop: ocoLegAckSchema,
  target: ocoLegAckSchema,
  // The C# dedup replayed a completed pair without a fresh Submit.
  deduped: z.boolean().optional(),
  // EFFECTIVE tick-rounded prices (stop leg's stopPrice, target leg's limitPrice).
  stopPrice: z.number().optional(),
  limitPrice: z.number().optional(),
});
export type OcoAckMessage = z.infer<typeof ocoAckMessageSchema>;

// ---------- companion-NinjaScript request seam ----------
// The ONE inbound path where NT8 asks the server for something rather than
// answering it. Deliberately vocabulary-free: `kind` is an opaque routing
// string and `payload` an opaque bag, so a private companion indicator can
// define its own request types without any of its vocabulary landing here.
// Handlers register in bridge/client-requests.ts; public code registers none.
//
// Correlation is inverted relative to reqMsg's usual use: NT8 mints the `id`
// and holds the pending call, the server echoes it back on client_response.

export const clientRequestMessageSchema = reqMsg("client_request", {
  kind: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type ClientRequestMessage = z.infer<typeof clientRequestMessageSchema>;

/** `ok:false` carries `error` and no payload — an unroutable kind is a normal
 *  outcome (deploy skew: newer indicator, older server), not a protocol fault. */
export const clientResponseMessageSchema = reqMsg("client_response", {
  kind: z.string().min(1),
  ok: z.boolean(),
  payload: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type ClientResponseMessage = z.infer<typeof clientResponseMessageSchema>;

export const errorMessageSchema = reqMsg("error", {
  message: z.string(),
  // Machine-readable classifier; C# sets it on every place_order rejection,
  // older AddOns and non-order rejections omit it — consumers must tolerate absence.
  code: z.string().optional(),
});
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

// Registering here admits a type to parseMessage and adds it to InboundMessage.
const INBOUND_SCHEMAS = {
  hello: helloMessageSchema,
  heartbeat: heartbeatMessageSchema,
  instruments_update: instrumentsUpdateMessageSchema,
  candles_response: candlesResponseMessageSchema,
  bar_close: barCloseMessageSchema,
  session_calendar_response: sessionCalendarResponseMessageSchema,
  open_charts_response: openChartsResponseMessageSchema,
  navigate_chart_ack: navigateChartAckMessageSchema,
  drawings_response: drawingsResponseMessageSchema,
  chart_indicators_response: chartIndicatorsResponseMessageSchema,
  indicator_values_response: indicatorValuesResponseMessageSchema,
  subscribe_ack: subscribeAckMessageSchema,
  unsubscribe_ack: unsubscribeAckMessageSchema,
  positions_response: positionsResponseMessageSchema,
  subscribe_positions_ack: subscribePositionsAckMessageSchema,
  unsubscribe_positions_ack: unsubscribePositionsAckMessageSchema,
  position_sync: positionSyncMessageSchema,
  position_event: positionEventMessageSchema,
  order_ack: orderAckMessageSchema,
  cancel_ack: cancelAckMessageSchema,
  cancel_all_ack: cancelAllAckMessageSchema,
  flatten_ack: flattenAckMessageSchema,
  change_ack: changeAckMessageSchema,
  oco_ack: ocoAckMessageSchema,
  client_request: clientRequestMessageSchema,
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
  | NavigateChartMessage
  | RequestDrawingsMessage
  | RequestChartIndicatorsMessage
  | RequestIndicatorValuesMessage
  | SubscribeBarsMessage
  | UnsubscribeBarsMessage
  | RequestPositionsMessage
  | SubscribePositionsMessage
  | UnsubscribePositionsMessage
  | PlaceOrderMessage
  | PlaceOcoMessage
  | CancelOrderMessage
  | CancelAllMessage
  | FlattenMessage
  | ChangeOrderMessage
  | ClientResponseMessage;
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
