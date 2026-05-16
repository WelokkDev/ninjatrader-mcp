import { z } from "zod";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDayRange } from "../core/sessions/session-day.js";
import type { Candle } from "../core/types.js";
import { detectWaws } from "../private/waw/detector.js";
import {
  loadStrategy,
  strategyAdditionalTimeframes,
} from "../private/waw/strategy-loader.js";
import type { Strategy, MarketContext } from "../private/waw/types.js";

// scan_zones runs the configured detection pipeline against candles
// already in the SQLite cache and returns the matching zones. Companion
// to get_candles: get_candles fills the cache; scan_zones reads from it.
// On cache miss the tool returns a clear error rather than fetching —
// callers should run get_candles first.
//
// Strategy resolution: by default loads "default.json" from the
// strategies directory. A `strategyName` parameter selects an
// alternative file. `skipQuantifiers` filters the loaded strategy's
// quantifier list — names not in the loaded strategy surface under
// quantifiers.unknown but never fail the call.

const QUERY_SQL = `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC`;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STRATEGY_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Strategy files live in private/waw/strategies. After build, the
// build script copies them alongside the compiled JS so this relative
// path resolves identically in dev (src/) and production (build/).
const STRATEGY_DIR = path.resolve(__dirname, "../private/waw/strategies");

export interface ScanZonesArgs {
  symbol: string;
  timeframe: "15m" | "30m" | "1h" | "2h" | "4h";
  start: string;
  end: string;
  minWickCoverageOfPriorBody?: number;
  allowDojiAsCandle2?: boolean;
  skipQuantifiers?: string[];
  strategyName?: string;
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

function readStrategy(name: string): Strategy {
  if (!STRATEGY_NAME_RE.test(name)) {
    throw new Error(
      `Invalid strategyName "${name}". Allowed: letters, digits, "_", "-".`,
    );
  }
  const filePath = path.resolve(STRATEGY_DIR, `${name}.json`);
  const raw = readFileSync(filePath, "utf-8");
  return loadStrategy(raw);
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
    strategyName = "default",
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

    let baseStrategy: Strategy;
    try {
      baseStrategy = readStrategy(strategyName);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return err(`Failed to load strategy "${strategyName}": ${m}`);
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

    // Filter the loaded strategy's quantifier list by skipQuantifiers.
    // Names in skipQuantifiers that match nothing in the strategy
    // surface under quantifiers.unknown so callers can self-correct.
    const skipSet = new Set(skipQuantifiers);
    const loadedNames = baseStrategy.quantifiers.map((q) => q.name);
    const loadedSet = new Set(loadedNames);
    const skippedKnown = skipQuantifiers.filter((n) => loadedSet.has(n));
    const unknownSkips = skipQuantifiers.filter((n) => !loadedSet.has(n));
    const runQuantifiers = baseStrategy.quantifiers.filter(
      (q) => !skipSet.has(q.name),
    );
    const runNames = runQuantifiers.map((q) => q.name);

    // Detection settings: per-call overrides win over what's in the
    // strategy file. Existing API contract — callers can tune
    // minWickCoverageOfPriorBody / allowDojiAsCandle2 inline.
    const strategy: Strategy = {
      name: baseStrategy.name,
      detection: {
        allowDojiAsCandle2,
        minWickCoverageOfPriorBody,
      },
      quantifiers: runQuantifiers,
    };

    // Pre-fetch lower-TF candles for any quantifier that declares
    // `timeframes` in its config. Empty result sets are fine —
    // downstream quantifiers handle "available but no bars in window"
    // per their own insufficientDataPolicy.
    const additionalTfs = strategyAdditionalTimeframes(strategy);
    const lowerTimeframeCandles = new Map<string, readonly Candle[]>();
    for (const tf of additionalTfs) {
      if (tf === timeframe) continue; // primary TF; already fetched
      const rows = deps.db
        .prepare(QUERY_SQL)
        .all(symbol, tf, startTs, endTs) as Candle[];
      lowerTimeframeCandles.set(tf, rows);
    }

    const ctx: MarketContext = {
      candles,
      symbol,
      timeframe,
      lowerTimeframeCandles:
        lowerTimeframeCandles.size > 0 ? lowerTimeframeCandles : undefined,
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
            strategy: baseStrategy.name,
            range: {
              from: new Date(candles[0].timestamp * 1000).toISOString(),
              to: new Date(
                candles[candles.length - 1].timestamp * 1000,
              ).toISOString(),
            },
            candleCount: candles.length,
            additionalTimeframesFetched: [...lowerTimeframeCandles.keys()],
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
          "Names of quantifiers to skip on this scan. Unknown names are reported under quantifiers.unknown in the response rather than failing the call.",
        ),
      strategyName: z
        .string()
        .optional()
        .default("default")
        .describe(
          "Strategy file to load from src/private/waw/strategies/ (without the .json extension). Defaults to 'default'.",
        ),
    },
    handler,
  );
}
