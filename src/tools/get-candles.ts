import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { RAW_TIMEFRAMES, SUPPORTED_SYMBOLS } from "../core/constants.js";
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
  expectedCloseStamps,
  mismatchIsEmpty,
  validateSessionDay,
} from "../core/cache/validator.js";
import { classifySessionDay, ensureCached } from "../core/cache/fill.js";
import { isConnected as defaultIsConnected } from "../bridge/index.js";
import {
  computeDerivedForSessionDay,
  writeDerivedForSessionDay,
} from "../core/cache/derived.js";
import { prefetchManager } from "../prefetch-instance.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// A connected call fetches at most this many uncached session-days inline;
// colder ranges are refused toward prefetch_candles so a synchronous fill
// can't outlive the MCP tool-call timeout.
export const MAX_INLINE_COLD_DAYS = 10;

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
      return errorResult(`Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`);
    }

    if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      return errorResult("Invalid date format. Use YYYY-MM-DD.");
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
        return errorResult(
          `"${err.label}" is a market holiday${err.description ? ` (${err.description})` : ""} — no session that day. Pick an adjacent trading day.`,
        );
      }
      const m = err instanceof Error ? err.message : String(err);
      return errorResult(`Invalid session-day for ${symbol}: ${m}`);
    }

    if (startTs >= endTs) {
      return errorResult(`start session-day ${start} is not before end session-day ${end}`);
    }

    const requestedDays = sessionDaysOverlapping(startTs, endTs, config.session, calendar);
    let matched = requestedDays.reduce(
      (acc, day) => acc + expectedBarCount(day, timeframe),
      0,
    );
    if (matched > limit) {
      return errorResult(
        `Range [${start}, ${end}] at ${timeframe} holds ~${matched} bars, over the limit ${limit}. ` +
          `If the range is already cached, narrow it or re-issue with limit >= ${matched}. ` +
          `If it still needs fetching from NinjaTrader, start a background prefetch_candles job instead, then re-read here.`,
      );
    }

    const rawTF = fetchTimeframeFor(timeframe);
    const nowUnix = Math.floor(Date.now() / 1000);

    // Refuse inline fills past the cold-day cap. Disconnected calls do no
    // fetch work (instant per-window failures), so the guard doesn't apply.
    if (deps.isConnected()) {
      const coldDays = requestedDays.filter(
        (day) => classifySessionDay(deps.db, symbol, day, rawTF, nowUnix) !== "complete",
      );
      if (coldDays.length > MAX_INLINE_COLD_DAYS) {
        return errorResult(
          `Range [${start}, ${end}] has ${coldDays.length} session-day(s) not yet cached at ${rawTF} — ` +
            `over the inline maximum of ${MAX_INLINE_COLD_DAYS}. Start a background job: ` +
            `prefetch_candles {symbol: "${symbol}", timeframe: "${rawTF}", start: "${start}", end: "${end}"}, ` +
            `poll prefetch_status until it completes, then re-issue this get_candles.`,
        );
      }
    }

    // Fill any gaps in the cache at the raw TF that backs this request.
    // Day-aligned: any session-day that is empty, partial, or in-progress
    // triggers a fetch covering the entire session-day window.
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

    const isDerived = !RAW_TIMEFRAMES.includes(timeframe);

    let validation = validateRequestedRange(
      deps.db,
      symbol,
      finalDays,
      timeframe,
      nowUnix,
    );

    // No fetch path fixes derived rows that diverge from their 15m backing —
    // fill/prefetch classify at the raw TF and skip the day. Derived rows are
    // a pure function of the cached 15m, so re-derive locally and re-validate.
    // One attempt per call; days whose defects survive it stay loud.
    if (isDerived && validation.issues) {
      const count15mStmt = deps.db.prepare(
        `SELECT COUNT(*) AS c FROM candles
          WHERE symbol = ? AND timeframe = '15m' AND timestamp > ? AND timestamp <= ?`,
      );
      const healable = finalDays.filter(
        (day) =>
          day.endUnix <= nowUnix &&
          validation.issues!.some((i) => i.sessionDay === day.label) &&
          (count15mStmt.get(symbol, day.startUnix, day.endUnix) as { c: number }).c > 0,
      );
      if (healable.length > 0) {
        const cal = calendar;
        const cachedStampsStmt = deps.db.prepare(
          `SELECT timestamp FROM candles
            WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
            ORDER BY timestamp ASC`,
        );
        const healed: string[] = [];
        for (const day of healable) {
          const computed = computeDerivedForSessionDay(deps.db, symbol, day, config, cal, nowUnix);
          // Recompute would emit exactly the cached stamps: healing is a
          // no-op, so skip the write churn. The day stays loud via issues.
          let differs = false;
          for (const [tf, aggCandles] of computed) {
            const cached = (
              cachedStampsStmt.all(symbol, tf, day.startUnix, day.endUnix) as Array<{
                timestamp: number;
              }>
            ).map((r) => r.timestamp);
            if (
              cached.length !== aggCandles.length ||
              cached.some((t, i) => t !== aggCandles[i].timestamp)
            ) {
              differs = true;
              break;
            }
          }
          if (!differs) continue;
          deps.db.transaction(() => {
            writeDerivedForSessionDay(deps.db, symbol, day, computed);
          })();
          healed.push(day.label);
        }
        if (healed.length > 0) {
          console.error(
            `[get_candles] re-derived ${healed.length} day(s) whose derived rows diverged from their 15m backing for ${symbol}: ${healed.join(",")}`,
          );
          validation = validateRequestedRange(deps.db, symbol, finalDays, timeframe, nowUnix);
        }
      }
    }

    const stmt = deps.db.prepare(QUERY_SQL);
    const rowsRaw = stmt.all(symbol, timeframe, startTs, endTs, limit) as Candle[];

    // Rows outside every session-day window are residue (unfiltered seeds,
    // geometry shifts) that validation and the purge can't see — serving them
    // would present untrusted bars as clean. Excluded, never deleted: they may
    // be real bars orphaned by a calendar edit. LIMIT applies pre-filter, so
    // heavy residue can push canonical rows out; `truncated` keeps that loud.
    const rows = rowsRaw.filter((r) =>
      finalDays.some((d) => r.timestamp > d.startUnix && r.timestamp <= d.endUnix),
    );

    // The geometry gate keys on expected bars, but actual rows can exceed it
    // (orphan partials). Counted per session-day so inter-session residue
    // can't skew the math.
    const dayCountStmt = deps.db.prepare(
      `SELECT COUNT(*) AS c FROM candles
        WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?`,
    );
    const totalInRange = finalDays.reduce(
      (acc, d) =>
        acc + (dayCountStmt.get(symbol, timeframe, d.startUnix, d.endUnix) as { c: number }).c,
      0,
    );
    const truncated = totalInRange > rows.length;

    // From the flat range minus the per-day sum, not the served rows — the
    // LIMIT clips those, undercounting whenever residue falls past the clip.
    const { c: flatInRange } = dayCountStmt.get(symbol, timeframe, startTs, endTs) as {
      c: number;
    };
    const interSessionExcluded = flatInRange - totalInRange;

    // A derived bar in an in-progress day is partial when its stamp is off
    // the expected grid (bucket still forming), or when its stamp is canonical
    // but a 15m constituent is missing (NT8-side gap), so its OHLC covers only
    // part of the bucket. Closed days are covered by validation instead.
    let partialBars = 0;
    if (isDerived) {
      const cached15mStmt = deps.db.prepare(
        `SELECT timestamp FROM candles
          WHERE symbol = ? AND timeframe = '15m' AND timestamp > ? AND timestamp <= ?`,
      );
      for (const day of finalDays) {
        if (day.endUnix <= nowUnix) continue;
        const expected = expectedCloseStamps(day, timeframe);
        const expectedSet = new Set(expected);
        const expected15m = expectedCloseStamps(day, "15m");
        const cached15m = new Set(
          (cached15mStmt.all(symbol, day.startUnix, day.endUnix) as Array<{
            timestamp: number;
          }>).map((r) => r.timestamp),
        );
        for (const row of rows) {
          if (row.timestamp <= day.startUnix || row.timestamp > day.endUnix) continue;
          if (!expectedSet.has(row.timestamp)) {
            row.partial = true;
            partialBars++;
            continue;
          }
          const idx = expected.indexOf(row.timestamp);
          const bucketStart = idx > 0 ? expected[idx - 1] : day.startUnix;
          const holed = expected15m.some(
            (t) => t > bucketStart && t <= row.timestamp && !cached15m.has(t),
          );
          if (holed) {
            row.partial = true;
            partialBars++;
          }
        }
      }
    }

    // A day can have fully canonical derived stamps over a holed 15m stream,
    // since interior gaps preserve the bucket's last bar — so surface the
    // backing state. Only for days not already flagged at the requested TF,
    // which are loud once via validation.issues.
    let raw15m: ValidationSummary | undefined;
    if (isDerived) {
      const flagged = new Set((validation.issues ?? []).map((i) => i.sessionDay));
      const summary = validateRequestedRange(
        deps.db,
        symbol,
        finalDays.filter((d) => !flagged.has(d.label)),
        "15m",
        nowUnix,
      );
      if (summary.mismatch > 0) raw15m = summary;
    }

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
    } else if (raw15m) {
      warning = `Underlying 15m data is incomplete for ${raw15m.mismatch} session-day(s) backing this ${timeframe} request — derived bars over those days may aggregate only part of their bucket. See \`validation.raw_15m\`.`;
    } else if (interSessionExcluded > 0) {
      warning = `${interSessionExcluded} cached row(s) stamped between session-day windows were excluded from this response — legacy residue (pre-fix seed or session-geometry changes), invisible to validation.`;
    }

    // The single trust bit a consumer checks before relying on the data.
    // In-progress days don't falsify it (their forming bars carry
    // `partial: true` instead — see partial_bars).
    const dataComplete =
      validation.mismatch === 0 &&
      raw15m === undefined &&
      fillResult.windowsFailed === 0 &&
      !fillResult.bridgeDisconnected &&
      !truncated;

    const validationOut: ValidationSummary & { raw_15m?: ValidationSummary } = raw15m
      ? { ...validation, raw_15m: raw15m }
      : validation;

    return jsonResult({
      symbol,
      timeframe,
      count: rows.length,
      // Expected bar count for the full range from session geometry —
      // count < matched means bars are genuinely absent (gap), never
      // silently clipped.
      matched,
      truncated,
      data_complete: dataComplete,
      ...(partialBars > 0 && { partial_bars: partialBars }),
      ...(interSessionExcluded > 0 && {
        inter_session_rows_excluded: interSessionExcluded,
      }),
      candles: rows,
      validation: validationOut,
      ...(warning && { warning }),
    });
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
    "Fetch OHLCV candlestick data for a futures symbol. Returns bars from a local SQLite cache; on any gap in the requested [start, end] range, the missing session-day(s) are auto-fetched from NinjaTrader at the raw timeframe (5m direct, all other TFs from 15m), ingested with day-aligned overwrites, then served. In-progress (today's) session-days are always refetched; on derived TFs (30m-4h) the still-forming bar of an in-progress session carries `partial: true`, as does any in-progress-session bar whose 15m backing has a gap (`partial_bars` counts them) — do NOT use partial bars for pattern detection. Note: on a declared holiday whose early-close time hasn't been observed yet, the real final bar may stay flagged partial until the template close passes. Fails closed when the range's session geometry holds more bars than `limit` — it never silently truncates; pass a larger `limit` explicitly for big pulls. For a bounded/specific date range (backtest windows, batch pulls, exact dates), resolve and confirm the dates via resolve_session_days BEFORE fetching (its barCountEstimate sizes `limit`); for exploratory reads, prefer over-fetching (pad the range) over precision. Cold multi-day fills are capped: a call needing more than 10 uncached session-days is refused — start a background prefetch_candles job for those, then read from here once cached.",
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
