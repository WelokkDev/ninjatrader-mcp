import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BridgeRequestError,
  capsError,
  getAddonCaps as defaultGetAddonCaps,
  isConnected as defaultIsConnected,
  request as defaultRequest,
} from "../bridge/index.js";
import type { InboundMessage } from "../bridge/protocol.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";
import {
  indicatorSelectorError,
  indicatorSelectorPayload,
  type IndicatorSelectorArgs,
} from "./indicator-selector.js";

export interface SetIndicatorParamsArgs extends IndicatorSelectorArgs {
  params: Record<string, string | number | boolean>;
  reload?: boolean;
}

export interface SetIndicatorParamsDeps {
  isConnected: () => boolean;
  getAddonCaps: () => string[] | null;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<InboundMessage>;
}

/** Above the AddOn's worst case (~59s), so a call never gives up on work in flight. */
export const SET_INDICATOR_PARAMS_TIMEOUT_MS = 65_000;

const REQUIRED_CAP = "set_indicator_params";

export function createSetIndicatorParamsHandler(deps: SetIndicatorParamsDeps) {
  // One write at a time: an overlapping call would reload mid-rebuild.
  let inFlight = false;
  return async (args: SetIndicatorParamsArgs): Promise<ToolResult> => {
    if (!deps.isConnected()) {
      return errorResult(
        "NinjaTrader is not connected — start NT8 with the McpBridge AddOn before calling set_indicator_params.",
      );
    }
    const unsupported = capsError(REQUIRED_CAP, deps.getAddonCaps());
    if (unsupported !== null) return errorResult(unsupported);

    const selectorError = indicatorSelectorError("set_indicator_params", args);
    if (selectorError !== null) return errorResult(selectorError);
    const names = Object.keys(args.params ?? {});
    if (names.length === 0) {
      return errorResult(
        "set_indicator_params needs at least one setting in params, named as list_chart_indicators reports it (e.g. {Period: 50}).",
      );
    }

    const payload: Record<string, unknown> = { ...indicatorSelectorPayload(args), params: args.params };
    if (args.reload !== undefined) payload.reload = args.reload;

    if (inFlight) {
      return errorResult(
        "set_indicator_params is already running; wait for it to answer, then retry.",
      );
    }
    let res: InboundMessage;
    inFlight = true;
    try {
      res = await deps.request(
        "request_set_indicator_params",
        payload,
        SET_INDICATOR_PARAMS_TIMEOUT_MS,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Sent but unanswered: the write may have landed.
      if (err instanceof BridgeRequestError && err.wasSent) {
        return errorResult(
          `set_indicator_params ${err.kind === "timeout" ? `timed out after ${SET_INDICATOR_PARAMS_TIMEOUT_MS}ms` : `lost the connection (${err.kind})`} — the write may or may not have landed: call list_chart_indicators to see the indicator's current settings before retrying.`,
        );
      }
      return errorResult(`set_indicator_params failed: ${msg}`);
    } finally {
      inFlight = false;
    }
    if (res.type !== "set_indicator_params_response") {
      return errorResult(`set_indicator_params failed: unexpected response type '${res.type}'`);
    }

    // A refusal is a valid outcome, not a tool failure.
    if (!res.applied) {
      return jsonResult({
        applied: false,
        found: res.found,
        symbol: res.symbol ?? args.symbol,
        ...(res.timeframe !== undefined ? { timeframe: res.timeframe } : {}),
        ...(res.reason !== undefined ? { reason: res.reason } : {}),
        ...(res.errors.length > 0 ? { errors: res.errors } : {}),
        hint: res.found
          ? "Nothing was written — `reason` names the gate that refused."
          : "`reason` says whether the chart or the indicator is missing — list_chart_indicators shows what is open and refreshes id handles.",
      });
    }

    return jsonResult({
      applied: true,
      reloaded: res.reloaded,
      symbol: res.symbol ?? args.symbol,
      ...(res.timeframe !== undefined ? { timeframe: res.timeframe } : {}),
      ...(res.window !== undefined ? { window: res.window } : {}),
      ...(res.displayName !== undefined ? { displayName: res.displayName } : {}),
      ...(res.indicatorId !== undefined ? { id: res.indicatorId } : {}),
      changed: res.changed,
      ...(res.unchanged.length > 0 ? { unchanged: res.unchanged } : {}),
      ...(res.errors.length > 0 ? { errors: res.errors } : {}),
      ...(res.reason !== undefined ? { reason: res.reason } : {}),
      params: res.params,
    });
  };
}

export function registerSetIndicatorParams(server: McpServer): void {
  const handler = createSetIndicatorParamsHandler({
    isConnected: defaultIsConnected,
    getAddonCaps: defaultGetAddonCaps,
    request: defaultRequest,
  });
  server.tool(
    "set_indicator_params",
    "Change the settings of ONE indicator on an open NinjaTrader 8 chart — the write counterpart of list_chart_indicators, which names every setting and is the call to make first. NT8 only applies a changed setting by reloading NinjaScript on that chart, so this writes the values and then triggers that reload: every script on the chart re-runs over history, and signals a real-time-only indicator drew live are re-evaluated as history. reloaded:false alongside a non-empty `changed` means the values are set but the chart still shows the old ones — retry with reload:true; with an empty `changed` it just means nothing needed writing. The rebuilt indicator is a new instance, so keep the returned `id`; `changed` reports from/to, so reverting is one more call. A refusal is applied:false with a `reason`, not an error, and writes nothing: an ambiguous selector, any name or value that fails validation, or a strategy running in that chart window (the reload would restart it).",
    {
      symbol: z.string().min(1),
      timeframe: z.string().min(1).optional(),
      id: z
        .number()
        .int()
        .optional()
        .describe(
          "Indicator id from list_chart_indicators. Preferred for a write; pass exactly one of id or match.",
        ),
      match: z
        .object({
          name: z.string().min(1),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        })
        .optional()
        .describe(
          "Alternative to id: NT8 type name ('SMA' or the full name) plus params that pin one instance, e.g. {name: 'SMA', params: {Period: 20}}. Refused if it matches more than one indicator.",
        ),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe(
          "{settingName: value}, keyed by the `name` list_chart_indicators reports (not the label), e.g. {Period: 50, NumStdDev: 2}. Booleans for checkboxes, numbers for numeric fields, the option's own text for a dropdown.",
        ),
      reload: z
        .boolean()
        .optional()
        .describe(
          "Trigger the reload even when every value already matches — the retry after reloaded:false.",
        ),
    },
    handler,
  );
}
