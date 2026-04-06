import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import db from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import type { Candle } from "../core/types.js";

export function registerGetCandles(server: McpServer): void {
  server.tool(
    "get_candles",
    "Fetch OHLCV candlestick data for a futures symbol. Returns pre-aggregated candles from the database for the specified symbol, timeframe, and date range.",
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

      // Parse dates as UTC — RTH candles (13:30-20:00 UTC) always fall
      // within the same calendar date in UTC, so this is safe.
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

      const rows = db
        .prepare(
          `SELECT timestamp, open, high, low, close, volume
           FROM candles
           WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
           ORDER BY timestamp ASC
           LIMIT ?`,
        )
        .all(symbol, timeframe, startTs, endTs, limit) as Candle[];

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
