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
import { formatLocalISO } from "../core/time.js";
import { detectWaws } from "../private/waw/detector.js";
import { summarizeQuantifierResults } from "../private/waw/pipeline.js";
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
  wickContainmentTolerance?: number;
  skipQuantifiers?: string[];
  strategyName?: string;
  diagnosticMode?: boolean;
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
    wickContainmentTolerance = 0.05,
    skipQuantifiers = [],
    strategyName = "default",
    diagnosticMode = false,
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

    if (
      typeof wickContainmentTolerance !== "number" ||
      wickContainmentTolerance < 0 ||
      wickContainmentTolerance > 1
    ) {
      return err("wickContainmentTolerance must be a number in [0, 1]");
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
    const enabledQuantifiers = baseStrategy.quantifiers.filter(
      (q) => !skipSet.has(q.name),
    );
    const runNames = enabledQuantifiers.map((q) => q.name);

    // Detection settings: per-call overrides win over what's in the
    // strategy file. Existing API contract — callers can tune
    // minWickCoverageOfPriorBody / allowDojiAsCandle2 inline.
    const strategy: Strategy = {
      name: baseStrategy.name,
      detection: {
        allowDojiAsCandle2,
        minWickCoverageOfPriorBody,
        wickContainmentTolerance,
      },
      quantifiers: enabledQuantifiers,
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

    const zones = detectWaws(candles, ctx, strategy, { diagnosticMode });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            symbol,
            timeframe,
            session: config.session.name,
            strategy: baseStrategy.name,
            diagnosticMode,
            range: {
              from: formatLocalISO(
                candles[0].timestamp,
                config.session.timezone,
              ),
              to: formatLocalISO(
                candles[candles.length - 1].timestamp,
                config.session.timezone,
              ),
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
            zones: zones.map((z) => {
              const c1Unix = Math.floor(new Date(z.c1Timestamp).getTime() / 1000);
              const c2Unix = Math.floor(new Date(z.c2Timestamp).getTime() / 1000);
              return {
                ...z,
                c1Timestamp: formatLocalISO(c1Unix, config.session.timezone),
                c2Timestamp: formatLocalISO(c2Unix, config.session.timezone),
                c1TimestampUnix: c1Unix,
                c2TimestampUnix: c2Unix,
              };
            }),
            totalCount: zones.length,
            qualifiedCount: zones.filter((z) => z.qualified).length,
            // Per-quantifier rollup across all detected zones. pipelineIndex
            // exposes the effective run order so callers can interpret passRate
            // Set diagnosticMode: true for unbiased per-quantifier numbers.
            quantifierStats: summarizeQuantifierResults(zones, runNames),
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
      wickContainmentTolerance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.05)
        .describe(
          "Fraction of c1 body height by which c2's wick may extend outside c1's body before the pair is rejected. Defaults to 0.05 (5%) to forgive sub-tick noise on otherwise-clean pairs; set to 0 for strict containment. Applied to both ends of the wick.",
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
      diagnosticMode: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Research/audit mode. When true, every enabled quantifier evaluates on every detected zone (no short-circuit), so quantifierResults[] carries a verdict per quantifier even on disqualified zones, and quantifierStats.passRate is unbiased. When false, late-pipeline quantifiers' passRate is conditional on earlier passes. Slower; opt in for full failure diagnosis or unbiased per-quantifier selectivity.",
        ),
    },
    handler,
  );
}
