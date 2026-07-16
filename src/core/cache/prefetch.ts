import type { Database } from "better-sqlite3";
import type { SessionDay, SessionTemplate } from "../sessions/types.js";
import type { Timeframe } from "../types.js";
import { loadCalendar } from "../sessions/calendar.js";
import { sessionDayRange } from "../sessions/session-day.js";
import { classifySessionDay, CANDLE_FETCH_TIMEOUT_MS, observeEarlyClose } from "./fill.js";
import { expectedBarCount } from "./validator.js";

// PrefetchManager — the single owner of request_candles traffic.
//
// Two lanes over one executor: foreground get_candles fills (high
// priority) and background job days (low priority), exactly one bridge
// request in flight — NT8 and the data provider handle concurrent history
// requests poorly. A resolved request is not success: every day is
// re-classified against the cache after its response, and failures stay
// on the job for prefetch_status. Jobs are in-memory; the cache is the
// durable state — re-issuing a prefetch after a restart fetches only the
// still-missing days. Queue wait does not count against the bridge
// timeout; the timer starts when the request fires.

export type BridgeRequest = (
  type: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export interface PrefetchDeps {
  db: Database;
  isConnected: () => boolean;
  request: BridgeRequest;
  /** Clock (ms). Injectable so tests pin durations/ETAs deterministically. */
  nowMs?: () => number;
}

type DayState =
  | "pending"
  | "fetching"
  | "fetched"
  | "failed"
  | "cancelled"
  // Complete by execute time (hi-lane fill, late response) — no bridge
  // request issued; reported under alreadyComplete.
  | "skipped";

interface JobDay {
  day: SessionDay;
  state: DayState;
  error?: string;
  inProgress?: boolean; // fetched while the session was still open
}

export type PrefetchJobState =
  | "running"
  | "completed"
  | "completed_with_failures"
  | "cancelled";

interface Job {
  id: string;
  symbol: string;
  rawTimeframe: Exclude<Timeframe, "1d">;
  template: SessionTemplate;
  createdAtMs: number;
  finishedAtMs: number | null;
  state: PrefetchJobState;
  days: JobDay[];
  alreadyComplete: string[];
  durationsMs: number[];
  expectedBarsToFetch: number;
}

export interface PrefetchJobSnapshot {
  jobId: string;
  symbol: string;
  timeframe: Timeframe;
  state: PrefetchJobState;
  daysTotal: number;
  alreadyComplete: number;
  fetched: number;
  failed: number;
  pending: number;
  cancelled: number;
  currentDay: string | null;
  inProgressDays: string[];
  expectedBarsToFetch: number;
  etaSecs: number | null;
  /** Per-day failure detail, capped at 10 entries; `failed` is the full count. */
  failures: Array<{ day: string; error: string }>;
  createdAt: number;
  finishedAt: number | null;
}

export interface StartJobArgs {
  symbol: string;
  rawTimeframe: Exclude<Timeframe, "1d">;
  days: SessionDay[];
  template: SessionTemplate;
}

const MAX_RETAINED_TERMINAL_JOBS = 20;
const MAX_REPORTED_FAILURES = 10;

type QueueTask = () => Promise<void>;

export class PrefetchManager {
  private readonly deps: PrefetchDeps;
  private readonly nowMs: () => number;
  private readonly hi: QueueTask[] = [];
  private readonly lo: QueueTask[] = [];
  private inFlight = false;
  private readonly jobs = new Map<string, Job>();
  private readonly settlers = new Map<string, Array<() => void>>();
  private seq = 0;

  constructor(deps: PrefetchDeps) {
    this.deps = deps;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  /** Foreground lane: interactive fills run ahead of queued batch days. */
  scheduledRequest(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.hi.push(async () => {
        try {
          resolve(await this.deps.request(type, payload, timeoutMs));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      void this.pump();
    });
  }

  startJob(args: StartJobArgs): { error: string } | { job: PrefetchJobSnapshot } {
    if (!this.deps.isConnected()) {
      return {
        error:
          "NinjaTrader is not connected — start NT8 with the McpBridge addon, then retry. (Refusing to enqueue a job that would fail on every day.)",
      };
    }

    const nowSec = Math.floor(this.nowMs() / 1000);
    const alreadyComplete: string[] = [];
    const toFetch: SessionDay[] = [];
    for (const day of args.days) {
      const cls = classifySessionDay(this.deps.db, args.symbol, day, args.rawTimeframe, nowSec);
      if (cls === "complete") alreadyComplete.push(day.label);
      else toFetch.push(day);
    }

    // One owner per (symbol, timeframe, day) — overlapping jobs would
    // double-fetch.
    for (const other of this.jobs.values()) {
      if (other.state !== "running") continue;
      if (other.symbol !== args.symbol || other.rawTimeframe !== args.rawTimeframe) continue;
      const owned = new Set(
        other.days
          .filter((d) => d.state === "pending" || d.state === "fetching")
          .map((d) => d.day.label),
      );
      const clash = toFetch.filter((d) => owned.has(d.label)).map((d) => d.label);
      if (clash.length > 0) {
        const head = clash.slice(0, 3).join(", ");
        const more = clash.length > 3 ? ` …and ${clash.length - 3} more` : "";
        return {
          error: `Job ${other.id} is already fetching ${clash.length} of these day(s): ${head}${more}. Poll prefetch_status for it or cancel it first.`,
        };
      }
    }

    const id = `pf-${(++this.seq).toString(36)}`;
    const job: Job = {
      id,
      symbol: args.symbol,
      rawTimeframe: args.rawTimeframe,
      template: args.template,
      createdAtMs: this.nowMs(),
      finishedAtMs: null,
      state: toFetch.length > 0 ? "running" : "completed",
      days: toFetch.map((day) => ({ day, state: "pending" as DayState })),
      alreadyComplete,
      durationsMs: [],
      expectedBarsToFetch: toFetch.reduce(
        (acc, d) => acc + expectedBarCount(d, args.rawTimeframe),
        0,
      ),
    };
    this.jobs.set(id, job);
    this.pruneTerminal();

    if (toFetch.length === 0) {
      job.finishedAtMs = this.nowMs();
      this.settle(id);
    } else {
      for (const d of job.days) {
        this.lo.push(() => this.executeDay(job, d));
      }
      void this.pump();
    }

    return { job: this.snapshot(job) };
  }

  status(): { jobs: PrefetchJobSnapshot[] };
  status(jobId: string): { error: string } | { job: PrefetchJobSnapshot };
  status(
    jobId?: string,
  ): { jobs: PrefetchJobSnapshot[] } | { error: string } | { job: PrefetchJobSnapshot } {
    if (jobId === undefined) {
      const jobs = [...this.jobs.values()]
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map((j) => this.snapshot(j));
      return { jobs };
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      return { error: `unknown prefetch job "${jobId}" — jobs do not survive a server restart (the cache does; re-issue prefetch_candles to resume)` };
    }
    return { job: this.snapshot(job) };
  }

  cancel(jobId: string): { error: string } | { job: PrefetchJobSnapshot } {
    const job = this.jobs.get(jobId);
    if (!job) return { error: `unknown prefetch job "${jobId}"` };
    if (job.state === "running") {
      job.state = "cancelled";
      // Pending day-tasks self-skip; the in-flight request finishes and
      // its data still heals the cache.
    }
    return { job: this.snapshot(job) };
  }

  /** Resolves once the job is terminal AND its queued tasks have drained. */
  whenSettled(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return Promise.reject(new Error(`unknown prefetch job "${jobId}"`));
    if (this.isSettled(job)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.settlers.get(jobId) ?? [];
      list.push(resolve);
      this.settlers.set(jobId, list);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    if (this.inFlight) return;
    const task = this.hi.shift() ?? this.lo.shift();
    if (!task) return;
    this.inFlight = true;
    try {
      await task();
    } catch (err) {
      // Task bodies handle their own errors; a bookkeeping bug must never
      // kill the executor loop.
      console.error("[prefetch] task error:", err);
    } finally {
      this.inFlight = false;
      void this.pump();
    }
  }

  private async executeDay(job: Job, d: JobDay): Promise<void> {
    if (job.state === "cancelled") {
      d.state = "cancelled";
      this.finalizeIfDone(job);
      return;
    }

    // A day can complete while queued (hi-lane inline fill, another
    // response): refetching is churn, and a degraded response could downgrade
    // it under day-refill ingest. Classify against current calendar geometry
    // rather than the window frozen at startJob — an early close recorded
    // since would make a complete cache read as partial, then fail.
    const freshDay = (): SessionDay => {
      try {
        const cal = loadCalendar(this.deps.db, job.template.name);
        return { label: d.day.label, ...sessionDayRange(d.day.label, job.template, cal) };
      } catch {
        // Day declared closed or unresolvable while queued — keep the
        // job-creation geometry and let the fetch path stay loud.
        return d.day;
      }
    };

    {
      const nowSec = Math.floor(this.nowMs() / 1000);
      if (
        classifySessionDay(this.deps.db, job.symbol, freshDay(), job.rawTimeframe, nowSec) ===
        "complete"
      ) {
        d.state = "skipped";
        this.finalizeIfDone(job);
        return;
      }
    }

    d.state = "fetching";
    const t0 = this.nowMs();
    try {
      await this.deps.request(
        "request_candles",
        {
          symbol: job.symbol,
          timeframe: job.rawTimeframe,
          from: d.day.startUnix,
          to: d.day.endUnix,
          tradingHoursTemplate: job.template.name,
        },
        CANDLE_FETCH_TIMEOUT_MS,
      );

      // Verify what actually landed — ingest runs in the candles_response
      // handler before this continuation resumes. Against current geometry,
      // since ingest stored the bars under the current calendar.
      const nowSec = Math.floor(this.nowMs() / 1000);
      const cls = classifySessionDay(this.deps.db, job.symbol, freshDay(), job.rawTimeframe, nowSec);
      if (cls === "complete") {
        d.state = "fetched";
      } else if (cls === "in_progress") {
        d.state = "fetched";
        d.inProgress = true;
      } else if (this.observedEarlyCloseHealed(job, d.day, nowSec)) {
        // Declared-but-untimed early close — observed, recorded, and
        // re-verified against the adjusted geometry.
        d.state = "fetched";
      } else {
        d.state = "failed";
        d.error = `response received but the day is still ${cls} in the cache — bars were dropped, never sent, or this is an undeclared holiday early close (check the session calendar and server logs)`;
      }
      job.durationsMs.push(this.nowMs() - t0);
    } catch (err) {
      d.state = "failed";
      d.error = err instanceof Error ? err.message : String(err);
    }
    this.finalizeIfDone(job);
  }

  /** Try the observed-close interlock for a day that failed verification;
   *  returns true iff a close was recorded AND the day re-verifies complete
   *  under the adjusted geometry. */
  private observedEarlyCloseHealed(job: Job, day: SessionDay, nowSec: number): boolean {
    const calendar = loadCalendar(this.deps.db, job.template.name);
    if (
      !observeEarlyClose(this.deps.db, job.symbol, job.rawTimeframe, day, job.template, calendar, nowSec)
    ) {
      return false;
    }
    try {
      const fresh = loadCalendar(this.deps.db, job.template.name);
      const adjusted = sessionDayRange(day.label, job.template, fresh);
      return (
        classifySessionDay(
          this.deps.db,
          job.symbol,
          { label: day.label, ...adjusted },
          job.rawTimeframe,
          nowSec,
        ) === "complete"
      );
    } catch {
      return false;
    }
  }

  private finalizeIfDone(job: Job): void {
    const open = job.days.some((d) => d.state === "pending" || d.state === "fetching");
    if (open) return;
    if (job.state !== "cancelled") {
      job.state = job.days.some((d) => d.state === "failed")
        ? "completed_with_failures"
        : "completed";
    }
    job.finishedAtMs = this.nowMs();
    const s = this.snapshot(job);
    console.error(
      `[prefetch] ${job.id} ${job.state}: ${s.fetched} fetched, ${s.failed} failed, ${s.cancelled} cancelled (${job.symbol} ${job.rawTimeframe})`,
    );
    this.settle(job.id);
    this.pruneTerminal();
  }

  private isSettled(job: Job): boolean {
    return (
      job.state !== "running" &&
      !job.days.some((d) => d.state === "pending" || d.state === "fetching")
    );
  }

  private settle(jobId: string): void {
    const list = this.settlers.get(jobId);
    if (!list) return;
    this.settlers.delete(jobId);
    for (const resolve of list) resolve();
  }

  private pruneTerminal(): void {
    // Only settled jobs are prunable — a cancelled job can still have
    // day-tasks draining, and evicting it would orphan whenSettled promises.
    const terminal = [...this.jobs.values()]
      .filter((j) => j.state !== "running" && this.isSettled(j))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    for (const j of terminal.slice(MAX_RETAINED_TERMINAL_JOBS)) {
      this.jobs.delete(j.id);
      this.settlers.delete(j.id);
    }
  }

  private snapshot(job: Job): PrefetchJobSnapshot {
    let fetched = 0;
    let skipped = 0;
    let failed = 0;
    let pending = 0;
    let cancelled = 0;
    let currentDay: string | null = null;
    const inProgressDays: string[] = [];
    const failures: Array<{ day: string; error: string }> = [];
    for (const d of job.days) {
      switch (d.state) {
        case "fetched":
          fetched++;
          if (d.inProgress) inProgressDays.push(d.day.label);
          break;
        case "skipped":
          skipped++;
          break;
        case "failed":
          failed++;
          if (failures.length < MAX_REPORTED_FAILURES) {
            failures.push({ day: d.day.label, error: d.error ?? "unknown error" });
          }
          break;
        case "fetching":
          currentDay = d.day.label;
          pending++;
          break;
        case "pending":
          pending++;
          break;
        case "cancelled":
          cancelled++;
          break;
      }
    }
    const etaSecs =
      job.durationsMs.length > 0 && pending > 0
        ? Math.max(
            1,
            Math.round(
              (job.durationsMs.reduce((a, b) => a + b, 0) / job.durationsMs.length / 1000) *
                pending,
            ),
          )
        : null;
    return {
      jobId: job.id,
      symbol: job.symbol,
      timeframe: job.rawTimeframe,
      state: job.state,
      daysTotal: job.days.length + job.alreadyComplete.length,
      // Plan-time completes plus execute-time skips, so `fetched` stays
      // reconcilable against actual bridge round-trips.
      alreadyComplete: job.alreadyComplete.length + skipped,
      fetched,
      failed,
      pending,
      cancelled,
      currentDay,
      inProgressDays,
      expectedBarsToFetch: job.expectedBarsToFetch,
      etaSecs,
      failures,
      createdAt: Math.floor(job.createdAtMs / 1000),
      finishedAt: job.finishedAtMs === null ? null : Math.floor(job.finishedAtMs / 1000),
    };
  }
}
