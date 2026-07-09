import { z } from "zod";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import {
  isConnected as defaultIsConnected,
  send as defaultSend,
} from "../bridge/index.js";
import type {
  OutboundMessage,
  DrawZoneMessage,
  ClearZonesMessage,
} from "../bridge/protocol.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDayRange } from "../core/sessions/session-day.js";
import { loadCalendar } from "../core/sessions/calendar.js";
import type { Candle } from "../core/types.js";
import { formatLocalISO } from "../core/time.js";
import { detectWaws } from "../private/waw/detector.js";
import { summarizeQuantifierResults } from "../private/waw/pipeline.js";
import {
  loadStrategy,
  strategyAdditionalTimeframes,
} from "../private/waw/strategy-loader.js";
import type {
  Strategy,
  MarketContext,
  QuantifierResult,
  Zone,
} from "../private/waw/types.js";

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

// A score filter expresses a per-quantifier acceptance window. A zone is  kept iff EVERY filter is satisfied. 
// A filter is satisfied when the named quantifier's score is in [min, max] (each bound optional). When the named quantifier didn't produce a score 
// (no `score` field on its  result, or the quantifier wasn't in the run set), the filter consults`includeNull`: false (default) drops the zone, true keeps it.
export interface ScoreFilter {
  quantifier: string;
  min?: number;
  max?: number;
  includeNull?: boolean;
}

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
  scoreFilters?: ScoreFilter[];
  draw?: boolean;
  clearBeforeDraw?: boolean;
}

export interface ScanZonesDeps {
  db: Database;
  isConnected?: () => boolean;
  send?: (message: OutboundMessage) => boolean;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

// Pure filter helper. Exported for direct unit testing.
export function passesScoreFilters(
  results: readonly QuantifierResult[],
  filters: readonly ScoreFilter[],
): boolean {
  for (const f of filters) {
    const r = results.find((q) => q.quantifierName === f.quantifier);
    const score = r?.score;
    if (score === undefined || score === null) {
      if (!f.includeNull) return false;
      continue;
    }
    if (f.min !== undefined && score < f.min) return false;
    if (f.max !== undefined && score > f.max) return false;
  }
  return true;
}

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
  const isConnectedFn = deps.isConnected ?? defaultIsConnected;
  const sendFn = deps.send ?? defaultSend;

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
    scoreFilters = [],
    draw = false,
    clearBeforeDraw = true,
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
    // Closed holidays throw SessionClosedError; its message surfaces below.
    const calendar = loadCalendar(deps.db, config.session.name);
    let startTs: number;
    let endTs: number;
    try {
      startTs = sessionDayRange(start, config.session, calendar).startUnix;
      endTs = sessionDayRange(end, config.session, calendar).endUnix;
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
    // Names in skipQuantifiers that match nothing in the strategy surface under quantifiers.unknown so callers can self-correct.
    const skipSet = new Set(skipQuantifiers);
    const loadedNames = baseStrategy.quantifiers.map((q) => q.name);
    const loadedSet = new Set(loadedNames);
    const skippedKnown = skipQuantifiers.filter((n) => loadedSet.has(n));
    const unknownSkips = skipQuantifiers.filter((n) => !loadedSet.has(n));
    const enabledQuantifiers = baseStrategy.quantifiers.filter(
      (q) => !skipSet.has(q.name),
    );
    const runNames = enabledQuantifiers.map((q) => q.name);

    // Detection settings: per-call overrides win over what's in the strategy file. 
    // Existing API contract — callers can tune minWickCoverageOfPriorBody / allowDojiAsCandle2 inline.
    const strategy: Strategy = {
      name: baseStrategy.name,
      detection: {
        allowDojiAsCandle2,
        minWickCoverageOfPriorBody,
        wickContainmentTolerance,
      },
      quantifiers: enabledQuantifiers,
    };

    // Pre-fetch additional-TF candles for any quantifier that declares `timeframes` in its config. 
    // Empty result sets are fine, downstream quantifiers handle "available but no bars in window" per their own insufficientDataPolicy. 
    // The same pre-fetched data is exposed under two MarketContext fields with disjoint consumer families
    const additionalTfs = strategyAdditionalTimeframes(strategy);
    const additionalCandles = new Map<string, readonly Candle[]>();
    for (const tf of additionalTfs) {
      if (tf === timeframe) continue; // primary TF; already fetched
      const rows = deps.db
        .prepare(QUERY_SQL)
        .all(symbol, tf, startTs, endTs) as Candle[];
      additionalCandles.set(tf, rows);
    }

    const ctx: MarketContext = {
      candles,
      symbol,
      timeframe,
      lowerTimeframeCandles:
        additionalCandles.size > 0 ? additionalCandles : undefined,
      smaCandles:
        additionalCandles.size > 0 ? additionalCandles : undefined,
    };

    // Pipeline always runs every enabled quantifier on every detected
    // zone — no short-circuit, no mode flag. Earlier callers passed
    // diagnosticMode to disable short-circuit; the short-circuit is now
    // gone and the flag has been removed.
    const zones = detectWaws(candles, ctx, strategy);

    // Decorate zones with parallel unix-second timestamps so callers
    // (and the draw path below) don't have to re-parse the ISO strings.
    const decoratedZones = zones.map((z) => {
      const c1Unix = Math.floor(new Date(z.c1Timestamp).getTime() / 1000);
      const c2Unix = Math.floor(new Date(z.c2Timestamp).getTime() / 1000);
      return {
        ...z,
        c1Timestamp: formatLocalISO(c1Unix, config.session.timezone),
        c2Timestamp: formatLocalISO(c2Unix, config.session.timezone),
        c1TimestampUnix: c1Unix,
        c2TimestampUnix: c2Unix,
      };
    });

    // Apply scoreFilters to derive the survivor set. An empty filter
    // list passes everything through (no filtering).
    const survivors =
      scoreFilters.length > 0
        ? decoratedZones.filter((z) =>
            passesScoreFilters(z.quantifierResults, scoreFilters),
          )
        : decoratedZones;

    // Optional auto-draw of survivors on the NT8 chart. Drawing failures
    // never block the scan response — the report below still surfaces
    // every zone and its scores regardless of draw status.
    let drawInfo: {
      requested: boolean;
      dispatched: boolean;
      cleared: boolean;
      drawnIds: string[];
      reason?: string;
    } = {
      requested: draw,
      dispatched: false,
      cleared: false,
      drawnIds: [],
    };
    if (draw) {
      if (!isConnectedFn()) {
        drawInfo.reason =
          "NinjaTrader is not connected — survivors were not drawn. Start NT8 with the McpBridge AddOn and rerun with draw=true.";
      } else {
        if (clearBeforeDraw) {
          const clearMsg: ClearZonesMessage = {
            v: 1,
            type: "clear_zones",
            symbol,
          };
          drawInfo.cleared = sendFn(clearMsg);
        }
        for (const z of survivors) {
          const drawId = `${symbol}_${timeframe}_${z.type}_${z.c2TimestampUnix}`;
          const msg: DrawZoneMessage = {
            v: 1,
            type: "draw_zone",
            id: drawId,
            symbol,
            proximal: z.proximal,
            distal: z.distal,
            fromTs: z.c2TimestampUnix,
          };
          if (sendFn(msg)) drawInfo.drawnIds.push(drawId);
        }
        drawInfo.dispatched = drawInfo.drawnIds.length === survivors.length;
      }
    }

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
            additionalTimeframesFetched: [...additionalCandles.keys()],
            quantifiers: {
              run: runNames,
              skipped: skippedKnown,
              unknown: unknownSkips,
            },
            zones: survivors,
            totalCount: decoratedZones.length,
            qualifiedCount: decoratedZones.filter((z) => z.qualified).length,
            survivorCount: survivors.length,
            scoreFiltersApplied: scoreFilters.length,
            drawInfo,
            quantifierStats: summarizeQuantifierResults(
              decoratedZones,
              runNames,
            ),
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
    "Run the configured detection pipeline on cached candles for a symbol/timeframe/session-day range. Returns matching zones with their metadata. Read-only over the cache — call get_candles first to populate it. For a bounded/specific date range, resolve and confirm the dates via resolve_session_days before scanning; for exploratory scans, prefer padding the range over precision.",
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
      scoreFilters: z
        .array(
          z.object({
            quantifier: z
              .string()
              .min(1)
              .describe(
                "Quantifier name as registered in the loaded strategy's run set. When the named quantifier isn't in the run set, the filter consults includeNull.",
              ),
            min: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("Inclusive lower bound on the quantifier's score."),
            max: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("Inclusive upper bound on the quantifier's score."),
            includeNull: z
              .boolean()
              .optional()
              .default(false)
              .describe(
                "When the quantifier produced no score on the zone, or wasn't in the run set, false (default) drops the zone, true keeps it.",
              ),
          }),
        )
        .optional()
        .default([])
        .describe(
          "Per-quantifier acceptance windows applied after detection. A zone survives iff every filter is satisfied. Filters are policy, not pipeline — every quantifier still evaluates on every zone; filters only decide what comes back in zones[] (and what gets drawn).",
        ),
      draw: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, draw surviving zones (after scoreFilters) on the connected NinjaTrader chart. Requires the McpBridge AddOn to be running; otherwise drawInfo.reason explains the skip.",
        ),
      clearBeforeDraw: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Only honored when draw=true. When true (default), clear existing zone rectangles on the chart for this symbol before drawing the new survivor set. Set false to draw additively.",
        ),
    },
    handler,
  );
}
