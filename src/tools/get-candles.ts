import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDayRange } from "../core/sessions/session-day.js";
import type { Candle, Timeframe } from "../core/types.js";
import { validateSessionDay } from "../core/cache/validator.js";
import { ensureCached } from "../core/cache/fill.js";
import {
  isConnected as defaultIsConnected,
  request as defaultRequest,
} from "../bridge/index.js";
import { ingestCandles as defaultIngestCandles } from "../bridge/ingest.js";

// Session-day query semantics: startUnix is exclusive, endUnix is inclusive
const QUERY_SQL = `SELECT timestamp, open, high, low, close, volume, indicators_json
       FROM candles
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT ?`;

export interface GetCandlesArgs {
  symbol: string;
  timeframe: "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h";
  start: string;
  end: string;
  limit?: number;
}

// 1m and 5m are independent raw streams. Everything else derives from 15m.
function fetchTimeframeFor(requested: Timeframe): Timeframe {
  if (requested === "1m" || requested === "5m") return requested;
  return "15m";
}

// Wilder's RSI(period). Returns null for candles with insufficient prior data.
function computeRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) { result[period] = 100; }
  else { result[period] = 100 - 100 / (1 + avgGain / avgLoss); }
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
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

interface ValidationIssue {
  sessionDay: string;
  status: "empty" | "incomplete";
  missingCount: number;
  extraCount: number;
  sampleMissing?: number[];
  sampleExtra?: number[];
}

interface ValidationSummary {
  ok: number;
  mismatch: number;
  in_progress: number;
  issues?: ValidationIssue[];
  in_progress_days?: string[];
}

// Final-pass validation over the user's exact requested range at the
// REQUESTED TF (not the raw TF). Reports per-day status in the response.
function validateRequestedRange(
  db: Database,
  symbol: string,
  classifications: ReadonlyArray<{ day: { label: string; startUnix: number; endUnix: number }; class: string }>,
  timeframe: Timeframe,
  nowUnix: number,
): ValidationSummary {
  const summary: ValidationSummary = { ok: 0, mismatch: 0, in_progress: 0 };
  const issues: ValidationIssue[] = [];
  const inProgressDays: string[] = [];

  for (const { day } of classifications) {
    const r = validateSessionDay(db, symbol, day, timeframe, nowUnix);
    if (r.status === "skipped") {
      summary.in_progress++;
      inProgressDays.push(day.label);
    } else if (r.status === "ok") {
      summary.ok++;
    } else {
      summary.mismatch++;
      const isEmpty = r.actual.length === 0;
      issues.push({
        sessionDay: r.sessionDay,
        status: isEmpty ? "empty" : "incomplete",
        missingCount: r.missing.length,
        extraCount: r.extra.length,
        ...(r.missing.length > 0 && { sampleMissing: r.missing.slice(0, 6) }),
        ...(r.extra.length > 0 && { sampleExtra: r.extra.slice(0, 6) }),
      });
    }
  }

  if (issues.length > 0) summary.issues = issues;
  if (inProgressDays.length > 0) summary.in_progress_days = inProgressDays;
  return summary;
}

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

    // Fill any gaps in the cache at the raw TF that backs this request.
    // Day-aligned: any session-day that is empty, partial, or in-progress
    // triggers a fetch covering the entire session-day window.
    const rawTF = fetchTimeframeFor(timeframe);
    const nowUnix = Math.floor(Date.now() / 1000);
    const fillResult = await ensureCached(
      deps.db,
      symbol,
      startTs,
      endTs,
      rawTF,
      config.session,
      {
        isConnected: deps.isConnected,
        request: deps.request,
        ingestCandles: deps.ingestCandles,
      },
      nowUnix,
    );

    if (fillResult.windowsFetched > 0) {
      console.error(
        `[get_candles] filled ${fillResult.windowsFetched} window(s) for ${symbol} ${rawTF}; days=${fillResult.fetchedDays.join(",")}`,
      );
    }

    // Now query the user's exact range at the requested TF.
    const stmt = deps.db.prepare(QUERY_SQL);
    const rawRows = stmt.all(symbol, timeframe, startTs, endTs, limit) as Array<Candle & { indicators_json?: string | null }>;

    // Merge stored indicators, then fill RSI server-side where absent.
    const closes = rawRows.map((r) => r.close);
    const rsiValues = computeRSI(closes);
    const rows = rawRows.map((r, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: Record<string, any> = {
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      };
      if (r.indicators_json) {
        try {
          const ind = JSON.parse(r.indicators_json) as Record<string, unknown>;
          Object.assign(out, ind);
          if (out.rsi == null && rsiValues[i] !== null) out.rsi = rsiValues[i];
        } catch { /* malformed JSON — ignore */ }
      } else if (rsiValues[i] !== null) {
        out.rsi = rsiValues[i];
      }
      return out;
    });

    const validation = validateRequestedRange(
      deps.db,
      symbol,
      fillResult.classifications,
      timeframe,
      nowUnix,
    );

    // Compose the warning string. Preserve the legacy
    // "NinjaTrader is not connected" guidance verbatim — existing
    // callers/tests pattern-match on it.
    let warning: string | undefined;
    if (fillResult.bridgeDisconnected && rows.length === 0) {
      warning = `No cached data for ${symbol} ${timeframe} in this range. NinjaTrader is not connected — start NT8 with the McpBridge addon to fetch live data.`;
    } else if (fillResult.windowsFailed > 0) {
      const summary = fillResult.errors
        .slice(0, 3)
        .map((e) => `${e.window} (${e.message})`)
        .join("; ");
      const more =
        fillResult.errors.length > 3
          ? ` …and ${fillResult.errors.length - 3} more`
          : "";
      const conn = fillResult.bridgeDisconnected
        ? " NinjaTrader is not connected — start NT8 with the McpBridge addon."
        : "";
      warning = `Could not fill ${fillResult.windowsFailed} gap(s): ${summary}${more}.${conn}`;
    } else if (validation.mismatch > 0) {
      warning = `Cache validation flagged ${validation.mismatch} session-day(s) at ${timeframe}. See \`validation.issues\` for details.`;
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
            validation,
            ...(warning && { warning }),
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
    "Fetch OHLCV + indicator candlestick data for a futures symbol. Returns bars from a local SQLite cache; on any gap in the requested [start, end] range, the missing session-day(s) are auto-fetched from NinjaTrader at the raw timeframe (1m and 5m direct, all other TFs from 15m), ingested with day-aligned overwrites, then served. Each bar includes RSI(14) computed server-side. Bars enriched by the McpDataExporter NT8 indicator also include eff_vol, eff_vol_total, eff_vol_ema, gex (GEX levels), and ryfvap (Value Area levels).",
    {
      symbol: z.string().describe("Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC)"),
      timeframe: z
        .enum(["1m", "5m", "15m", "30m", "1h", "2h", "4h"])
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
