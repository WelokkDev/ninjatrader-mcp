import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { isRawTimeframe, RAW_TIMEFRAMES, SUPPORTED_SYMBOLS } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  SessionClosedError,
  sessionDayRange,
  sessionDaysOverlapping,
} from "../core/sessions/session-day.js";
import { loadCalendar } from "../core/sessions/calendar.js";
import type { Timeframe } from "../core/types.js";
import { isConnected as defaultIsConnected } from "../bridge/index.js";
import { isInboundType } from "../bridge/protocol.js";
import { parseContractName, sameContract } from "../bridge/contract-windows.js";
import { candleFetchTimeoutMs } from "../core/cache/fill.js";
import { prefetchManager } from "../prefetch-instance.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// Diagnostic read of ONE named expiry, straight off the wire.
//
// Deliberately NOT cacheable: two expiries trade at different prices at the same
// instant, so writing both into one symbol's rows would manufacture a contract
// seam. The reply is flagged `pinned` and the ingest handler drops it.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// This path has no cache, no resume and no batching.
const MAX_DAYS = 5;

export interface GetContractCandlesArgs {
  symbol: string;
  contract: string;
  timeframe: Timeframe;
  start: string;
  end: string;
  limit?: number;
}

export interface GetContractCandlesDeps {
  db: Database;
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

export function createGetContractCandlesHandler(deps: GetContractCandlesDeps) {
  return async ({
    symbol,
    contract,
    timeframe,
    start,
    end,
    limit = 500,
  }: GetContractCandlesArgs): Promise<ToolResult> => {
    // `symbol` still drives session/timeframe policy, so it stays a bare
    // registry key; `contract` names the expiry NT8 binds.
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return errorResult(
        `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
      );
    }
    if (!contract.trim()) return errorResult("contract is required (e.g. 'NQ SEP26')");
    // `symbol` drives the session template, so another instrument's contract
    // would be bucketed on the wrong session and labelled with this symbol.
    const parsed = parseContractName(contract);
    if (parsed === null) {
      return errorResult(
        `Could not read a delivery month from "${contract}". Use NT8's own spelling, ` +
          `e.g. 'NQ SEP26' or 'NQ 09-26'.`,
      );
    }
    if (parsed.symbol.toUpperCase() !== symbol.toUpperCase()) {
      return errorResult(
        `contract "${contract}" is not a ${symbol} contract (it names ${parsed.symbol}).`,
      );
    }
    if (!isRawTimeframe(timeframe)) {
      return errorResult(
        `${timeframe} is derived from 15m inside the cache, and this tool does not cache. ` +
          `Ask for a raw timeframe (${RAW_TIMEFRAMES.join(", ")}) and aggregate yourself.`,
      );
    }
    if (!Number.isInteger(limit) || limit < 1) {
      return errorResult(`limit must be a positive integer (got ${limit}).`);
    }
    if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      return errorResult("Invalid date format. Use YYYY-MM-DD.");
    }
    if (!deps.isConnected()) {
      return errorResult("NinjaTrader is not connected — this tool reads live from NT8 only.");
    }

    const config = getInstrumentConfig(symbol);
    const calendar = loadCalendar(deps.db, config.session.name);
    let startTs: number;
    let endTs: number;
    try {
      startTs = sessionDayRange(start, config.session, calendar).startUnix;
      endTs = sessionDayRange(end, config.session, calendar).endUnix;
    } catch (err) {
      if (err instanceof SessionClosedError) {
        return errorResult(
          `"${err.label}" is a market holiday${err.description ? ` (${err.description})` : ""} — no session that day.`,
        );
      }
      const m = err instanceof Error ? err.message : String(err);
      return errorResult(`Invalid session-day for ${symbol}: ${m}`);
    }
    if (startTs >= endTs) {
      return errorResult(`start session-day ${start} is not before end session-day ${end}`);
    }
    // Session-days are 23h but start 24h apart, so a wall-clock span would
    // refuse a legitimate week that crosses a weekend.
    const dayCount = sessionDaysOverlapping(startTs, endTs, config.session, calendar).length;
    if (dayCount > MAX_DAYS) {
      return errorResult(
        `Range [${start}, ${end}] covers ${dayCount} session-days, over the ${MAX_DAYS}-day cap. ` +
          `This path is uncached and single-shot — narrow it.`,
      );
    }

    let reply: unknown;
    try {
      reply = await deps.request("request_candles", {
        symbol,
        timeframe,
        from: startTs,
        to: endTs,
        tradingHoursTemplate: config.session.name,
        contract,
      }, candleFetchTimeoutMs(timeframe));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return errorResult(`NT8 refused the pinned fetch for ${contract}: ${m}`);
    }

    if (!isInboundType(reply, "candles_response")) {
      const t = reply && typeof reply === "object" ? (reply as { type?: unknown }).type : reply;
      return errorResult(`Unexpected reply type from NT8: ${String(t)}`);
    }

    // Deploy skew: an AddOn predating the pin ignores `contract` and answers
    // with the front month, which reads as a successful pinned fetch.
    if (reply.pinned !== true) {
      return errorResult(
        `The connected AddOn ignored the pinned contract (no 'pinned' flag in its reply) — ` +
          `it predates this feature. Recompile mcp-bridge.cs in the NinjaScript Editor, then ` +
          `restart NinjaTrader so the AddOn instance reloads.`,
      );
    }
    if (reply.contract !== undefined && !sameContract(reply.contract, contract)) {
      return errorResult(
        `Asked NT8 for ${contract} but it bound ${reply.contract}. Nothing was cached; ` +
          `check [McpBridge] ResolveInstrument in NinjaScript Output tab 1.`,
      );
    }

    const candles = reply.candles.slice(0, limit);
    return jsonResult({
      symbol,
      contract: reply.contract ?? contract,
      timeframe,
      count: candles.length,
      truncated: reply.candles.length > candles.length,
      cached: false,
      priceBasis: reply.priceBasis ?? "unknown",
      mergePolicy: reply.mergePolicy ?? "unknown",
      candles,
    });
  };
}

export function registerGetContractCandles(server: McpServer): void {
  const handler = createGetContractCandlesHandler({
    db: defaultDb,
    isConnected: defaultIsConnected,
    request: (type, payload, timeoutMs) =>
      prefetchManager.scheduledRequest(type, payload, timeoutMs),
  });

  server.tool(
    "get_contract_candles",
    "Diagnostic: fetch bars for ONE explicitly named futures contract (e.g. 'NQ SEP26'), bypassing NinjaTrader's front-month resolution. Use this to see what a specific expiry actually traded at — comparing two expiries across a roll, confirming which contract NT8 is serving, or checking whether a suspected wrong-contract fetch really is one. Results are returned straight from NT8 and are NEVER written to the cache: two expiries trade at different prices at the same instant, so mixing them into one symbol's rows would manufacture a false price gap. For normal charting and analysis use get_candles, which serves the front-month view the cache is keyed on. Raw timeframes only, max 5 session-days, and NinjaTrader must be connected.",
    {
      symbol: z
        .string()
        .describe(
          "Bare futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC). Drives the session calendar and trading-hours template; the expiry comes from `contract`.",
        ),
      contract: z
        .string()
        .describe(
          "Full NT8 contract name for the expiry to bind, exactly as NinjaTrader spells it — 'NQ SEP26' on some installs, 'NQ 09-26' on others. Check an existing chart tab or Tools > Instruments if unsure; a name NT8 does not know is refused rather than substituted.",
        ),
      timeframe: z
        .enum(RAW_TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]])
        .describe(
          "Raw timeframe served directly by NT8. Derived timeframes (30m-4h) are built from 15m inside the cache, which this path does not use.",
        ),
      start: z.string().describe("Start session-day (YYYY-MM-DD) in the instrument's session timezone."),
      end: z.string().describe("End session-day (YYYY-MM-DD), inclusive. At most 5 days after `start`."),
      limit: z.number().optional().default(500).describe("Maximum candles to return (default 500)."),
    },
    handler,
  );
}
