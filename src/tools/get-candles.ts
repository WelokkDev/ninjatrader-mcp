import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import {
  SessionClosedError,
  sessionDayRange,
  sessionDaysOverlapping,
} from "../core/sessions/session-day.js";
import { loadCalendar } from "../core/sessions/calendar.js";
import type { SessionDay } from "../core/sessions/types.js";
import type { Candle, Timeframe } from "../core/types.js";
import {
  expectedBarCount,
  mismatchIsEmpty,
  validateSessionDay,
} from "../core/cache/validator.js";
import { ensureCached } from "../core/cache/fill.js";
import { isConnected as defaultIsConnected } from "../bridge/index.js";
import { prefetchManager } from "../prefetch-instance.js";

// Session-day query semantics: startUnix is exclusive, endUnix is inclusive
const QUERY_SQL = `SELECT timestamp, open, high, low, close, volume
       FROM candles
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC
      LIMIT ?`;

export interface GetCandlesArgs {
  symbol: string;
  timeframe: "15s" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h";
  start: string;
  end: string;
  limit?: number;
}

// 15s and 5m are their own raw streams; everything else derives from
// 15m via the aggregation chain in ingest.ts.
function fetchTimeframeFor(requested: Timeframe): Timeframe {
  if (requested === "15s" || requested === "5m") return requested;
  return "15m";
}

export interface GetCandlesDeps {
  db: Database;
  isConnected: () => boolean;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
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

// Final-pass validation over the requested range at the REQUESTED TF.
// Takes the (possibly calendar-refreshed) day list — after an observed
// early close, validation must run against the adjusted geometry.
function validateRequestedRange(
  db: Database,
  symbol: string,
  days: readonly SessionDay[],
  timeframe: Timeframe,
  nowUnix: number,
): ValidationSummary {
  const summary: ValidationSummary = { ok: 0, mismatch: 0, in_progress: 0 };
  const issues: ValidationIssue[] = [];
  const inProgressDays: string[] = [];

  for (const day of days) {
    const r = validateSessionDay(db, symbol, day, timeframe, nowUnix);
    if (r.status === "skipped") {
      summary.in_progress++;
      inProgressDays.push(day.label);
    } else if (r.status === "ok") {
      summary.ok++;
    } else {
      summary.mismatch++;
      issues.push({
        sessionDay: r.sessionDay,
        status: mismatchIsEmpty(r) ? "empty" : "incomplete",
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
    let calendar = loadCalendar(deps.db, config.session.name);
    let startTs: number;
    let endTs: number;
    try {
      const startRange = sessionDayRange(start, config.session, calendar);
      const endRange = sessionDayRange(end, config.session, calendar);
      startTs = startRange.startUnix;
      endTs = endRange.endUnix;
    } catch (err) {
      if (err instanceof SessionClosedError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `"${err.label}" is a market holiday${err.description ? ` (${err.description})` : ""} — no session that day. Pick an adjacent trading day.`,
            },
          ],
        };
      }
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

    const requestedDays = sessionDaysOverlapping(startTs, endTs, config.session, calendar);
    let matched = requestedDays.reduce(
      (acc, day) => acc + expectedBarCount(day, timeframe),
      0,
    );
    if (matched > limit) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Range [${start}, ${end}] at ${timeframe} holds ~${matched} bars, over the limit ${limit}. Narrow the range or pass limit >= ${matched}.`,
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
      },
      nowUnix,
      calendar,
    );

    if (fillResult.windowsFetched > 0) {
      console.error(
        `[get_candles] filled ${fillResult.windowsFetched} window(s) for ${symbol} ${rawTF}; days=${fillResult.fetchedDays.join(",")}`,
      );
    }

    // If the fill recorded a new early close, reload the calendar so
    // validation and `matched` use the adjusted geometry this same call.
    let finalDays: SessionDay[] = requestedDays;
    if (fillResult.calendarUpdated) {
      calendar = loadCalendar(deps.db, config.session.name);
      finalDays = sessionDaysOverlapping(startTs, endTs, config.session, calendar);
      matched = finalDays.reduce((acc, day) => acc + expectedBarCount(day, timeframe), 0);
    }

    // Now query the user's exact range at the requested TF.
    const stmt = deps.db.prepare(QUERY_SQL);
    const rows = stmt.all(symbol, timeframe, startTs, endTs, limit) as Candle[];

    // The geometry gate keys on EXPECTED bars, but actual rows can exceed
    // expected (orphan partial bars) — if the LIMIT clipped anything, say so.
    const { c: totalInRange } = deps.db
      .prepare(
        `SELECT COUNT(*) AS c FROM candles
          WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?`,
      )
      .get(symbol, timeframe, startTs, endTs) as { c: number };
    const truncated = totalInRange > rows.length;

    const validation = validateRequestedRange(
      deps.db,
      symbol,
      finalDays,
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
    } else if (truncated) {
      warning = `Response truncated: the range holds ${totalInRange} rows at ${timeframe} but only ${rows.length} were returned (limit ${limit}). Actual rows exceed expected geometry — likely orphan partial bars; see \`validation.issues\`.`;
    } else if (validation.mismatch > 0) {
      warning = `Cache validation flagged ${validation.mismatch} session-day(s) at ${timeframe}. See \`validation.issues\` for details. If this is a holiday early close, connect NT8 to sync the session calendar, or add a manual session_calendar row.`;
    }

    // The single trust bit a consumer checks before relying on the data.
    // In-progress days don't falsify it (see validation.in_progress_days).
    const dataComplete =
      validation.mismatch === 0 &&
      fillResult.windowsFailed === 0 &&
      !fillResult.bridgeDisconnected &&
      !truncated;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            symbol,
            timeframe,
            count: rows.length,
            // Expected bar count for the full range from session geometry —
            // count < matched means bars are genuinely absent (gap), never
            // silently clipped.
            matched,
            truncated,
            data_complete: dataComplete,
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
    // Inline fills ride the prefetch manager's high-priority lane — all
    // candle traffic is single-flight, interactive calls first.
    request: (type, payload, timeoutMs) =>
      prefetchManager.scheduledRequest(type, payload, timeoutMs),
  });

  server.tool(
    "get_candles",
    "Fetch OHLCV candlestick data for a futures symbol. Returns bars from a local SQLite cache; on any gap in the requested [start, end] range, the missing session-day(s) are auto-fetched from NinjaTrader at the raw timeframe (5m direct, all other TFs from 15m), ingested with day-aligned overwrites, then served. In-progress (today's) session-days are always refetched. Fails closed when the range's session geometry holds more bars than `limit` — it never silently truncates; pass a larger `limit` explicitly for big pulls. For a bounded/specific date range (backtest windows, batch pulls, exact dates), resolve and confirm the dates via resolve_session_days BEFORE fetching (its barCountEstimate sizes `limit`); for exploratory reads, prefer over-fetching (pad the range) over precision. For MULTI-DAY cold fills, start a background prefetch_candles job instead of a long synchronous pull, then read from here once cached.",
    {
      symbol: z.string().describe("Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC)"),
      timeframe: z
        .enum(["15s", "5m", "15m", "30m", "1h", "2h", "4h"])
        .describe(
          "Candle timeframe. 15s and 5m are raw parallel streams; 30m–4h derive from 15m. 15s is DENSE (5,520 bars/session-day) — it always needs an explicit `limit` and is meant for engine consumption; use prefetch_candles for 15s batches.",
        ),
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
        .describe(
          "Maximum number of candles to return (default 500). The tool refuses fail-closed when the range's expected bar count exceeds this; size it up front with resolve_session_days.barCountEstimate.",
        ),
    },
    handler,
  );
}
