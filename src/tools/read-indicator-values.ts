import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected, request as defaultRequest } from "../bridge/index.js";
import type { InboundMessage } from "../bridge/protocol.js";
import { formatExchangeTime } from "../core/time.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export interface ReadIndicatorValuesArgs {
  symbol: string;
  timeframe?: string;
  id?: number;
  match?: { name: string; params?: Record<string, string | number | boolean> };
  from?: number;
  to?: number;
  bars?: number;
}

export interface ReadIndicatorValuesDeps {
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<InboundMessage>;
}

export const INDICATOR_VALUES_TIMEOUT_MS = 6_000;

// Mirrors the AddOn's IndicatorValuesMaxPoints.
export const INDICATOR_VALUES_MAX_POINTS = 5_000;

export function createReadIndicatorValuesHandler(deps: ReadIndicatorValuesDeps) {
  return async (args: ReadIndicatorValuesArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling read_indicator_values.",
      );
    }
    // Cross-field rules live here, not in the wire schema (placeOrderFields
    // convention): a bad call gets an actionable message, not a schema reject.
    const hasId = args.id !== undefined;
    const hasMatch = args.match !== undefined;
    if (hasId === hasMatch) {
      return errorResult(
        hasId
          ? "read_indicator_values takes either id or match, not both — id wins when you have it (call list_chart_indicators for one)."
          : "read_indicator_values needs an indicator selector: id (from list_chart_indicators) or match:{name, params}.",
      );
    }
    const hasRange = args.from !== undefined || args.to !== undefined;
    if (args.bars !== undefined && hasRange) {
      return errorResult(
        "read_indicator_values takes either bars (last N points) or from/to (unix seconds), not both.",
      );
    }
    if (args.from !== undefined && args.to !== undefined && args.to < args.from) {
      return errorResult(
        `read_indicator_values got to (${args.to}) before from (${args.from}) — the range is empty.`,
      );
    }

    const payload: Record<string, unknown> = { symbol: args.symbol };
    if (args.timeframe !== undefined) payload.timeframe = args.timeframe;
    // `indicatorId` on the wire, `id` in the tool API: a payload `id` would
    // clobber the envelope's correlation uuid.
    if (args.id !== undefined) payload.indicatorId = args.id;
    if (args.match !== undefined) payload.match = args.match;
    if (args.from !== undefined) payload.from = args.from;
    if (args.to !== undefined) payload.to = args.to;
    // No range means "the current value" — sent explicitly so the AddOn never
    // has to guess a default.
    if (args.bars !== undefined) payload.bars = args.bars;
    else if (!hasRange) payload.bars = 1;

    let res: InboundMessage;
    try {
      res = await deps.request("request_indicator_values", payload, INDICATOR_VALUES_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        return errorResult(
          `read_indicator_values timed out after ${INDICATOR_VALUES_TIMEOUT_MS}ms — either NT8's UI is busy, or the AddOn predates request_indicator_values (recompile ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor).`,
        );
      }
      return errorResult(`read_indicator_values failed: ${msg}`);
    }
    if (res.type !== "indicator_values_response") {
      return errorResult(`read_indicator_values failed: unexpected response type '${res.type}'`);
    }

    // A miss is a valid outcome, not a failure: handles die when a chart
    // reloads. Answer with what to do about it rather than isError.
    if (!res.found) {
      return jsonResult({
        found: false,
        symbol: args.symbol,
        ...(args.timeframe !== undefined ? { timeframe: args.timeframe } : {}),
        ...(res.reason !== undefined ? { reason: res.reason } : {}),
        hint: "No matching indicator on that chart — call list_chart_indicators to refresh the id handles (a chart reload or timeframe switch recreates indicators and invalidates ids).",
      });
    }

    const plots = res.plots.map((p) => ({
      ...p,
      ...(p.availableFrom !== null ? { availableFromTime: formatExchangeTime(p.availableFrom) } : {}),
      ...(p.availableTo !== null ? { availableToTime: formatExchangeTime(p.availableTo) } : {}),
    }));
    const pointCount = plots.reduce((n, p) => n + p.values.length, 0);

    return jsonResult({
      found: true,
      symbol: res.symbol ?? args.symbol,
      ...(res.timeframe !== undefined ? { timeframe: res.timeframe } : {}),
      ...(res.window !== undefined ? { window: res.window } : {}),
      // Back out as `id`: the same handle list_chart_indicators reports.
      ...(res.indicatorId !== undefined ? { id: res.indicatorId } : {}),
      ...(res.displayName !== undefined ? { displayName: res.displayName } : {}),
      ...(res.displacement !== undefined ? { displacement: res.displacement } : {}),
      ...(res.barCount !== undefined ? { barCount: res.barCount } : {}),
      ...(typeof res.barsFrom === "number" ? { barsFrom: res.barsFrom, barsFromTime: formatExchangeTime(res.barsFrom) } : {}),
      ...(typeof res.barsTo === "number" ? { barsTo: res.barsTo, barsToTime: formatExchangeTime(res.barsTo) } : {}),
      pointCount,
      plots,
      // >1: the selector was ambiguous and the first match was read.
      ...(res.matchCount !== undefined && res.matchCount > 1 ? { matchCount: res.matchCount } : {}),
      ...(plots.some((p) => p.truncated)
        ? {
            warning: `Window exceeded the ${INDICATOR_VALUES_MAX_POINTS}-point per-plot cap; the oldest points were dropped. Narrow from/to to see them.`,
          }
        : {}),
    });
  };
}

export function registerReadIndicatorValues(server: McpServer): void {
  const handler = createReadIndicatorValuesHandler({
    isConnected: defaultIsConnected,
    request: defaultRequest,
  });
  server.tool(
    "read_indicator_values",
    "Read the computed values of ONE indicator on an open NinjaTrader 8 chart — step 2 of the two-step indicator read. Call list_chart_indicators first to get the indicator's `id`, then poll here; this call is lean (values only, no reflection) and is the one to repeat. SELECTOR: pass id (preferred) OR match:{name, params} — name accepts 'SMA' or the full 'NinjaTrader.NinjaScript.Indicators.SMA', params disambiguates between several instances ({Period: 20}); exactly one of the two. RANGE: either bars:N (the last N points, the default is 1 = the current value) or from/to in unix seconds (either end may be omitted); not both. RESULT: one entry per plot — {name, values:[{t, v}], availableFrom, availableTo, truncated}. `t` is unix seconds on the same convention as get_candles, so points line up 1:1 with candles. availableFrom/To are what the indicator could actually serve: when they are narrower than what you asked for, you hit the instance's value-retention wall (readableDepth from list_chart_indicators), NOT a gap in the chart — compare them with barsFrom/barsTo, the chart's loaded window. found:false is normal and means the handle went stale (chart reload / timeframe switch); re-run list_chart_indicators. CAVEAT: values are NOT compensated for the indicator's Displacement — the response reports it so you can shift them yourself. Read-only: this cannot change an indicator.",
    {
      symbol: z.string().min(1),
      timeframe: z.string().min(1).optional(),
      id: z.number().int().optional(),
      match: z
        .object({
          name: z.string().min(1),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        })
        .optional(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
      bars: z.number().int().min(1).max(INDICATOR_VALUES_MAX_POINTS).optional(),
    },
    handler,
  );
}
