import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDayRange } from "../core/sessions/session-day.js";
import type { Candle, Timeframe } from "../core/types.js";
import {
  isConnected as defaultIsConnected,
  request as defaultRequest,
} from "../bridge/index.js";
import { ingestCandles as defaultIngestCandles } from "../bridge/ingest.js";

// Session-day query semantics: startUnix is exclusive, endUnix is inclusive
const QUERY_SQL = `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT ?`;

export interface GetCandlesArgs {
  symbol: string;
  timeframe: "5m" | "15m" | "30m" | "1h" | "2h" | "4h";
  start: string;
  end: string;
  limit?: number;
}

// 5m is its own raw stream; everything else derives from
// 15m via the aggregation chain in ingest.ts.
function fetchTimeframeFor(requested: Timeframe): Timeframe {
  return requested === "5m" ? "5m" : "15m";
}

export interface GetCandlesDeps {
  db: Database;
  isConnected: () => boolean;
  request: typeof defaultRequest;
  ingestCandles: typeof defaultIngestCandles;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createGetCandlesHandler(deps: GetCandlesDeps) {
  return async ({
    symbol,
    timeframe,
    start,
    end,
    limit = 500,
  }: GetCandlesArgs): Promise<ToolResult> => {
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
          },
        ],
      };
    }

    if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Invalid date format. Use YYYY-MM-DD.",
          },
        ],
      };
    }

    // Resolve start/end as session-days in the instrument's session
    // timezone. startUnix is exclusive; endUnix is inclusive (D.2).
    const config = getInstrumentConfig(symbol);
    let startTs: number;
    let endTs: number;
    try {
      const startRange = sessionDayRange(start, config.session);
      const endRange = sessionDayRange(end, config.session);
      startTs = startRange.startUnix;
      endTs = endRange.endUnix;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid session-day for ${symbol}: ${m}`,
          },
        ],
      };
    }

    if (startTs >= endTs) {
      return {
        content: [
          {
            type: "text" as const,
            text: `start session-day ${start} is not before end session-day ${end}`,
          },
        ],
      };
    }

    const stmt = deps.db.prepare(QUERY_SQL);
    let rows = stmt.all(symbol, timeframe, startTs, endTs, limit) as Candle[];

    if (rows.length === 0) {
      if (!deps.isConnected()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No cached data for ${symbol} ${timeframe} in this range. NinjaTrader is not connected — start NT8 with the McpBridge addon to fetch live data.`,
            },
          ],
        };
      }

      console.error(
        `[get_candles] Cache miss for ${symbol} ${timeframe} — requesting from NinjaTrader`,
      );

      const fetchTf = fetchTimeframeFor(timeframe);
      try {
        const response = (await deps.request("request_candles", {
          symbol,
          timeframe: fetchTf,
          from: startTs,
          to: endTs,
          tradingHoursTemplate: config.session.name,
        })) as {
          type: string;
          symbol: string;
          timeframe: string;
          candles: Candle[];
        };

        const fetched: Candle[] = response.candles.map((c) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));

        const result = deps.ingestCandles(symbol, fetchTf, fetched);
        console.error(
          `[get_candles] ingested ${result.inserted} ${fetchTf} bars for ${symbol}; aggregated=${JSON.stringify(result.aggregated)}`,
        );

        rows = stmt.all(symbol, timeframe, startTs, endTs, limit) as Candle[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[get_candles] bridge request failed: ${msg}`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                symbol,
                timeframe,
                count: rows.length,
                candles: rows,
                warning: `Partial data — NinjaTrader request failed: ${msg}`,
              }),
            },
          ],
        };
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            symbol,
            timeframe,
            count: rows.length,
            candles: rows,
          }),
        },
      ],
    };
  };
}

export function registerGetCandles(server: McpServer): void {
  const handler = createGetCandlesHandler({
    db: defaultDb,
    isConnected: defaultIsConnected,
    request: defaultRequest,
    ingestCandles: defaultIngestCandles,
  });

  server.tool(
    "get_candles",
    "Fetch OHLCV candlestick data for a futures symbol. Returns pre-aggregated candles from the database; on cache miss, requests bars from NinjaTrader (5m as a raw stream, all other TFs derived locally from 15m).",
    {
      symbol: z.string().describe("Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC)"),
      timeframe: z
        .enum(["5m", "15m", "30m", "1h", "2h", "4h"])
        .describe("Candle timeframe"),
      start: z
        .string()
        .describe(
          "Start session-day (YYYY-MM-DD) interpreted in the instrument's session timezone. For NQ/ES/YM/RTY this is the CME ETH session ending at 17:00 ET on the named date. Worked example: for NQ, '2026-05-01' = bars from Apr 30 18:00 ET through May 1 17:00 ET.",
        ),
      end: z
        .string()
        .describe(
          "End session-day (YYYY-MM-DD) interpreted in the instrument's session timezone, inclusive. Same convention as `start`.",
        ),
      limit: z
        .number()
        .optional()
        .default(500)
        .describe("Maximum number of candles to return (default 500)"),
    },
    handler,
  );
}
