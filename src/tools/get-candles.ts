import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import db from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import type { Candle } from "../core/types.js";
import { isConnected, request } from "../bridge/index.js";
import { ingestCandles } from "../bridge/ingest.js";

const QUERY_SQL = `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT ?`;

export function registerGetCandles(server: McpServer): void {
  server.tool(
    "get_candles",
    "Fetch OHLCV candlestick data for a futures symbol. Returns pre-aggregated candles from the database; on cache miss, requests 15m bars from NinjaTrader and aggregates locally.",
    {
      symbol: z.string().describe("Futures symbol (ES, NQ, YM, RTY, CL, GC)"),
      timeframe: z
        .enum(["15m", "30m", "1h", "2h", "4h"])
        .describe("Candle timeframe"),
      start: z.string().describe("Start date (YYYY-MM-DD)"),
      end: z.string().describe("End date (YYYY-MM-DD)"),
      limit: z
        .number()
        .optional()
        .default(500)
        .describe("Maximum number of candles to return (default 500)"),
    },
    async ({ symbol, timeframe, start, end, limit }) => {
      if (
        !SUPPORTED_SYMBOLS.includes(symbol as (typeof SUPPORTED_SYMBOLS)[number])
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
            },
          ],
        };
      }

      const startTs = Math.floor(Date.parse(start + "T00:00:00Z") / 1000);
      const endTs = Math.floor(Date.parse(end + "T23:59:59Z") / 1000);

      if (isNaN(startTs) || isNaN(endTs)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid date format. Use YYYY-MM-DD.",
            },
          ],
        };
      }

      const stmt = db.prepare(QUERY_SQL);
      let rows = stmt.all(symbol, timeframe, startTs, endTs, limit) as Candle[];

      if (rows.length === 0) {
        if (!isConnected()) {
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

        try {
          const response = (await request("request_candles", {
            symbol,
            timeframe: "15m",
            from: startTs,
            to: endTs,
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

          const result = ingestCandles(symbol, fetched);
          console.error(
            `[get_candles] ingested ${result.inserted} 15m bars for ${symbol}; aggregated=${JSON.stringify(result.aggregated)}`,
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
    },
  );
}
