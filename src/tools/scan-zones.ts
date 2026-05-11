import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDayRange } from "../core/sessions/session-day.js";
import type { Candle } from "../core/types.js";
import { detectWaws } from "../private/waw/detector.js";
import { quantifierRegistry } from "../private/waw/quantifiers/registry.js";
import type { Strategy, MarketContext } from "../private/waw/types.js";

// scan_zones runs the configured detection pipeline against candles
// already in the SQLite cache and returns the matching zones. Companion
// to get_candles: get_candles fills the cache; scan_zones reads from it.
// On cache miss the tool returns a clear error rather than fetching —
// callers should run get_candles first.

const QUERY_SQL = `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC`;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ScanZonesArgs {
  symbol: string;
  timeframe: "15m" | "30m" | "1h" | "2h" | "4h";
  start: string;
  end: string;
  minWickCoverageOfPriorBody?: number;
  allowDojiAsCandle2?: boolean;
  skipQuantifiers?: string[];
}

export interface ScanZonesDeps {
  db: Database;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

function err(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function createScanZonesHandler(deps: ScanZonesDeps) {
  return async ({
    symbol,
    timeframe,
    start,
    end,
    minWickCoverageOfPriorBody = 0,
    allowDojiAsCandle2 = false,
    skipQuantifiers = [],
  }: ScanZonesArgs): Promise<ToolResult> => {
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return err(
        `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
      );
    }

    if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      return err("Invalid date format. Use YYYY-MM-DD.");
    }

    if (
      typeof minWickCoverageOfPriorBody !== "number" ||
      minWickCoverageOfPriorBody < 0 ||
      minWickCoverageOfPriorBody > 1
    ) {
      return err("minWickCoverageOfPriorBody must be a number in [0, 1]");
    }

    const config = getInstrumentConfig(symbol);
    let startTs: number;
    let endTs: number;
    try {
      startTs = sessionDayRange(start, config.session).startUnix;
      endTs = sessionDayRange(end, config.session).endUnix;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return err(`Invalid session-day for ${symbol}: ${m}`);
    }

    if (startTs >= endTs) {
      return err(
        `start session-day ${start} is not before end session-day ${end}`,
      );
    }

    const candles = deps.db
      .prepare(QUERY_SQL)
      .all(symbol, timeframe, startTs, endTs) as Candle[];

    if (candles.length === 0) {
      return err(
        `No cached data for ${symbol} ${timeframe} in ${start}..${end}. Call get_candles first to populate the cache.`,
      );
    }

    // Build the run set: every registered quantifier minus the names
    // the caller asked to skip. Unknown skip names surface in the
    // response under quantifiers.unknown so callers can self-correct;
    // they don't fail the call.
    const allRegistered = quantifierRegistry.names();
    const skipSet = new Set(skipQuantifiers);
    const knownSet = new Set(allRegistered);
    const skippedKnown = skipQuantifiers.filter((n) => knownSet.has(n));
    const unknownSkips = skipQuantifiers.filter((n) => !knownSet.has(n));
    const runNames = allRegistered.filter((n) => !skipSet.has(n));

    const strategy: Strategy = {
      name: "scan_zones",
      detection: {
        allowDojiAsCandle2,
        minWickCoverageOfPriorBody,
      },
      quantifiers: runNames.map((name) => ({
        name,
        enabled: true,
        config: {},
      })),
    };

    const ctx: MarketContext = {
      candles,
      symbol,
      timeframe,
    };

    const zones = detectWaws(candles, ctx, strategy);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            symbol,
            timeframe,
            session: config.session.name,
            range: {
              from: new Date(candles[0].timestamp * 1000).toISOString(),
              to: new Date(
                candles[candles.length - 1].timestamp * 1000,
              ).toISOString(),
            },
            candleCount: candles.length,
            quantifiers: {
              run: runNames,
              skipped: skippedKnown,
              unknown: unknownSkips,
            },
            // Each zone is enriched with parallel unix-second
            // timestamps so callers can feed draw_zone (which expects
            // unix seconds) without re-parsing the ISO strings.
            zones: zones.map((z) => ({
              ...z,
              c1TimestampUnix: Math.floor(new Date(z.c1Timestamp).getTime() / 1000),
              c2TimestampUnix: Math.floor(new Date(z.c2Timestamp).getTime() / 1000),
            })),
            totalCount: zones.length,
            qualifiedCount: zones.filter((z) => z.qualified).length,
          }),
        },
      ],
    };
  };
}

export function registerScanZones(server: McpServer): void {
  const handler = createScanZonesHandler({ db: defaultDb });

  server.tool(
    "scan_zones",
    "Run the configured detection pipeline on cached candles for a symbol/timeframe/session-day range. Returns matching zones with their metadata. Read-only over the cache — call get_candles first to populate it.",
    {
      symbol: z
        .string()
        .describe(
          "Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC)",
        ),
      timeframe: z
        .enum(["15m", "30m", "1h", "2h", "4h"])
        .describe("Candle timeframe to scan"),
      start: z
        .string()
        .describe(
          "Start session-day (YYYY-MM-DD) interpreted in the instrument's session timezone. Same convention as get_candles.",
        ),
      end: z
        .string()
        .describe(
          "End session-day (YYYY-MM-DD) interpreted in the instrument's session timezone, inclusive.",
        ),
      minWickCoverageOfPriorBody: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0)
        .describe("Detection threshold in [0, 1] (default 0)"),
      allowDojiAsCandle2: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Allow doji bars as the second candle in a pair (default false)",
        ),
      skipQuantifiers: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          "Names of quantifiers to skip on this scan. Default runs every registered quantifier. Unknown names are reported under quantifiers.unknown in the response rather than failing the call.",
        ),
    },
    handler,
  );
}
