import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import { envSetting } from "../core/env-local.js";
import type { ProbeTicksArgs, StartTicksArgs, TickFetchManager } from "../nt8-lake/fetch-job.js";
import { show, status, type LakeContext } from "../nt8-lake/ops.js";
import { RefusedError } from "../nt8-lake/source.js";
import { hubLakeContext, tickFetchManager } from "../tick-fetch-instance.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";
import { STDIO_SESSION, type SessionContext } from "./session.js";

export interface TickToolDeps {
  manager: TickFetchManager;
  lake: () => LakeContext;
  owner?: string;
}

function refusal(err: unknown): ToolResult {
  if (err instanceof RefusedError) return errorResult(err.message);
  throw err;
}

export function createTickToolHandlers(deps: TickToolDeps) {
  const start = async (args: Omit<StartTicksArgs, "owner">): Promise<ToolResult> => {
    const res = await deps.manager.start({ ...args, ...(deps.owner !== undefined && { owner: deps.owner }) });
    if ("error" in res) return errorResult(res.error);
    return jsonResult({
      ...res.job,
      hint: `Background job started; poll prefetch_ticks_status { jobId: "${res.job.jobId}" }. Only "pending" days are fetched. Jobs do not survive a hub restart, but the lake does: re-issuing the same call fetches only what it lacks.`,
    });
  };

  const jobStatus = async ({ jobId }: { jobId?: string }): Promise<ToolResult> => {
    if (jobId === undefined) return jsonResult(deps.manager.status());
    const res = deps.manager.status(jobId);
    return "error" in res ? errorResult(res.error) : jsonResult(res.job);
  };

  const cancel = async ({ jobId, force }: { jobId: string; force?: boolean }): Promise<ToolResult> => {
    const res = deps.manager.cancel(jobId, { by: deps.owner, force });
    return "error" in res ? errorResult(res.error) : jsonResult(res.job);
  };

  const lakeStatus = async (args: { contract?: string; from?: string; to?: string }): Promise<ToolResult> => {
    try {
      return jsonResult({ days: status(deps.lake(), args) });
    } catch (err) {
      return refusal(err);
    }
  };

  const lakeShow = async ({ contract, session }: { contract: string; session: string }): Promise<ToolResult> => {
    try {
      return jsonResult(show(deps.lake(), contract, session));
    } catch (err) {
      return refusal(err);
    }
  };

  const probe = async (args: ProbeTicksArgs): Promise<ToolResult> => {
    const res = await deps.manager.probe(args);
    if ("error" in res) {
      const { error, ...extra } = res;
      return errorResult(error, extra);
    }
    return jsonResult(res.probe);
  };

  return { start, jobStatus, cancel, lakeStatus, lakeShow, probe };
}

const sessionLabel = z.string().describe("Session-day, YYYY-MM-DD (close-date convention).");

export function registerTickTools(server: McpServer, session: SessionContext = STDIO_SESSION): void {
  const h = createTickToolHandlers({ manager: tickFetchManager, lake: hubLakeContext, owner: session.source });

  server.tool(
    "prefetch_ticks",
    "Start a BACKGROUND fetch of whole session-days of NT8 tick data (every print, every best bid/ask change) into the NT8 tick lake, and return the plan at once: per session-day the contract (NT8's rollover table, or `contract`) and its state. Only `pending` days are fetched; `held` is already in the lake, `not_closed` has not closed, `closed` is a holiday, `unattested` has no rollover window (pass `contract`). One NT8 request per stream per calendar day, queued behind interactive candle fills; the AddOn refuses while any account holds a position or working order. A day is stored only when proven whole, then checked. Poll prefetch_ticks_status.",
    {
      symbol: z.string().describe(`Futures symbol (${SUPPORTED_SYMBOLS.join(", ")})`),
      start: sessionLabel,
      end: sessionLabel.describe("Last session-day, inclusive (YYYY-MM-DD)."),
      contract: z
        .string()
        .optional()
        .describe('Fetch this contract for every day, e.g. "MNQ 03-27", instead of the rollover table\'s'),
      refetch: z.boolean().optional().describe("Also fetch days the lake already holds; a different copy becomes a new take"),
    },
    h.start,
  );

  server.tool(
    "prefetch_ticks_status",
    "Progress of tick fetch jobs. Per day: state, the stream in flight, and once ingested the take, tier, failing checks and rows, or the reason it was not stored (a refused day's folder is kept and named). Without jobId: recent jobs, newest first.",
    { jobId: z.string().optional().describe("Job id from prefetch_ticks. Omit to list recent jobs.") },
    h.jobStatus,
  );

  server.tool(
    "prefetch_ticks_cancel",
    "Cancel a tick fetch job before its next NT8 request; a request in flight finishes. Another conversation's job is refused unless force:true.",
    {
      jobId: z.string().describe("Job id from prefetch_ticks."),
      force: z.boolean().optional().describe("Also cancel a job another conversation started"),
    },
    h.cancel,
  );

  server.tool(
    "tick_lake_status",
    "One line per session-day the NT8 tick lake holds or lacks between its stored days: take, tier (RAW < CLEAN < GOLD), failing checks, or missing / closed.",
    {
      contract: z.string().optional().describe('e.g. "MNQ 12-26"; omit for every contract'),
      from: z.string().optional().describe("First session-day, YYYY-MM-DD"),
      to: z.string().optional().describe("Last session-day, YYYY-MM-DD"),
    },
    h.lakeStatus,
  );

  server.tool(
    "tick_lake_show",
    "The review sheet for one stored session-day of the NT8 tick lake: every check with its numbers, facts per stream (rows, longest gaps, rows per hour), sides and delta, and each take's files.",
    { contract: z.string().describe('e.g. "MNQ 12-26"'), session: sessionLabel },
    h.lakeShow,
  );

  if (envSetting("NT_TICK_PROBE") === "1") {
    server.tool(
      "tick_fetch_probe",
      "Diagnostic: fetch one or two whole NT8-local calendar days of one contract and report rows, Parquet bytes and fingerprint per stream, plus every AddOn response (timings, memory, loaded vs written rows). Stores nothing in the lake; the fetched files stay in the drop folder (named in the result) until a job or probe starts 24 h later.",
      {
        contract: z.string().describe('Exact contract, e.g. "MNQ 12-26"'),
        days: z.array(z.string()).describe("One or two NT8-local calendar dates, YYYY-MM-DD"),
        lookup: z.enum(["provider", "repository"]).optional().describe("Ask the provider (default) or read NT8's local repository only"),
        tradingHours: z.string().optional().describe('NT8 Trading Hours template; default "Default 24 x 7"'),
        toOffsetDays: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe("BarsRequest toLocal = day + this; default 0"),
      },
      h.probe,
    );
  }
}
