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
import type { PrefetchManager } from "../core/cache/prefetch.js";
import { prefetchManager as defaultManager } from "../prefetch-instance.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// prefetch_candles / prefetch_status / prefetch_cancel — background,
// resumable batch ingestion. The tool call returns a job plan instantly;
// the fetch runs in-process, one NT8 request at a time, each day verified
// against the cache after its response.

export interface PrefetchStartArgs {
  symbol: string;
  timeframe: "15s" | "5m" | "15m";
  start: string;
  end: string;
}

export interface PrefetchToolDeps {
  manager: PrefetchManager;
  db: Database;
}

export function createPrefetchToolHandlers(deps: PrefetchToolDeps) {
  const start = async ({ symbol, timeframe, start, end }: PrefetchStartArgs): Promise<ToolResult> => {
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return errorResult(`Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`);
    }

    const config = getInstrumentConfig(symbol);
    const calendar = loadCalendar(deps.db, config.session.name);
    let startTs: number;
    let endTs: number;
    try {
      startTs = sessionDayRange(start, config.session, calendar).startUnix;
      endTs = sessionDayRange(end, config.session, calendar).endUnix;
    } catch (e) {
      if (e instanceof SessionClosedError) {
        return errorResult(
          `"${e.label}" is a market holiday${e.description ? ` (${e.description})` : ""} — no session that day. Pick an adjacent trading day (resolve_session_days shows the nearest ones).`,
        );
      }
      const m = e instanceof Error ? e.message : String(e);
      return errorResult(
        `Invalid session-day for ${symbol}: ${m}. A prefetch is a bounded batch — resolve the range with resolve_session_days first and use real session-day labels.`,
      );
    }
    if (startTs >= endTs) {
      return errorResult(`start session-day ${start} is not before end session-day ${end}`);
    }

    // Closed holidays vanish; early-close days carry adjusted geometry.
    const days = sessionDaysOverlapping(startTs, endTs, config.session, calendar);
    const res = deps.manager.startJob({
      symbol,
      rawTimeframe: timeframe,
      days,
      template: config.session,
    });
    if ("error" in res) return errorResult(res.error);
    return jsonResult({
      ...res.job,
      hint: `Background job started — poll prefetch_status { jobId: "${res.job.jobId}" } for progress; per-day failures are listed there. The job does not survive a server restart, but the cache does: re-issue the same prefetch to resume.`,
    });
  };

  const status = async ({ jobId }: { jobId?: string }): Promise<ToolResult> => {
    if (jobId === undefined) return jsonResult(deps.manager.status());
    const res = deps.manager.status(jobId);
    if ("error" in res) return errorResult(res.error);
    return jsonResult(res.job);
  };

  const cancel = async ({ jobId }: { jobId: string }): Promise<ToolResult> => {
    const res = deps.manager.cancel(jobId);
    if ("error" in res) return errorResult(res.error);
    return jsonResult(res.job);
  };

  return { start, status, cancel };
}

export function registerPrefetchTools(server: McpServer): void {
  const handlers = createPrefetchToolHandlers({ manager: defaultManager, db: defaultDb });

  server.tool(
    "prefetch_candles",
    "Start a BACKGROUND batch download of candle history into the local cache and return instantly with a job plan ({jobId, daysTotal, alreadyComplete, expectedBarsToFetch}). Use this instead of big synchronous get_candles pulls — the fetch runs one session-day at a time inside the server (kind to NT8), every day is verified against the cache after its response, and failures are recorded per-day. Fills the RAW stream: '5m' feeds 5m; '15m' also rebuilds the derived 30m–4h TFs. Already-complete days are skipped, so re-issuing the same range resumes after a crash or restart. A prefetch is a bounded batch: resolve and confirm the range with resolve_session_days BEFORE starting. Poll prefetch_status for progress; read the data afterwards with get_candles (instant once cached).",
    {
      symbol: z
        .string()
        .describe("Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC)"),
      timeframe: z
        .enum(["15s", "5m", "15m"])
        .describe(
          "RAW timeframe to ingest. '15m' also rebuilds the derived 30m/1h/2h/4h aggregates; '5m' and '15s' are their own parallel streams. 15s is tick-derived and dense (5,520 bars/day) — expect slower per-day fetches; this background job is the right transport for it.",
        ),
      start: z
        .string()
        .describe("Start session-day (YYYY-MM-DD, close-date convention, same as get_candles)."),
      end: z.string().describe("End session-day (YYYY-MM-DD), inclusive."),
    },
    handlers.start,
  );

  server.tool(
    "prefetch_status",
    "Progress and outcome of background prefetch jobs. With jobId: that job's snapshot — state (running / completed / completed_with_failures / cancelled), per-day counts, currentDay, etaSecs, and the exact per-day failures with reasons. Without jobId: all recent jobs, newest first — call this after a batch to confirm NOTHING failed silently. Jobs live in server memory; if the server restarted, re-issue prefetch_candles (already-cached days are skipped).",
    {
      jobId: z.string().optional().describe("Job id from prefetch_candles. Omit to list recent jobs."),
    },
    handlers.status,
  );

  server.tool(
    "prefetch_cancel",
    "Cancel a running prefetch job. The in-flight day is allowed to finish (its data still heals the cache); remaining days are skipped and reported as cancelled in prefetch_status.",
    {
      jobId: z.string().describe("Job id from prefetch_candles."),
    },
    handlers.cancel,
  );
}
