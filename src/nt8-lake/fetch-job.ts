import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { constants as osConstants, setPriority } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capsError } from "../bridge/caps.js";
import {
  canonicalContract,
  contractForLabel,
  parseContractName,
  sameContract,
  windowsFromResponse,
  type RolloverWindow,
} from "../bridge/contract-windows.js";
import { isSimulatedFeed } from "../bridge/data-source.js";
import { isInboundType, type TicksResponseMessage } from "../bridge/protocol.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import type { SessionCalendar } from "../core/sessions/calendar.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { NoSessionSpanError, sessionDayRange } from "../core/sessions/session-day.js";
import type { SessionTemplate } from "../core/sessions/types.js";
import { EXCHANGE_TZ, formatExchangeTime, tzParts, wallClockToUnix } from "../core/time.js";
import { identify, listTakes, sessionDir } from "./layout.js";
import type { IngestReport, ProbeReport } from "./ops.js";
import { cutsSpanning, TS_PER_SEC, type Cut } from "./session-cut.js";
import { RefusedError, STREAMS, type StreamName } from "./source.js";
import { MANIFEST_FILE, partFileName, type AddonManifest } from "./sources/addon.js";
import { writeJsonAtomic } from "./writer.js";

// The cap names the drop-file format, so an AddOn built for another is refused before NT8 loads.
export const TICK_CAP = "request_ticks.v2";
export const TICKS_ADDON_VERSION = "2";
export const TICK_LANE = "tick-fetch";
export const STREAM_TIMEOUT_MS = 15 * 60_000;
export const MIN_FREE_BYTES = 1024 ** 3;
export const STALE_FOLDER_MS = 24 * 3_600_000;
export const MAX_FAILED_IN_A_ROW = 3;
export const MAX_PROBE_DAYS = 2;
export const BUSY_RETRY_MS = 30_000;
export const BUSY_WAIT_MS = 15 * 60_000;
const RESOLVE_TIMEOUT_MS = 20_000;
const LAKE_RUN_TIMEOUT_MS = 60 * 60_000;
const MAX_RETAINED_JOBS = 20;

export interface Knobs {
  lookup: "provider" | "repository";
  tradingHours: string;
  toOffsetDays: 0 | 1;
}

export const JOB_KNOBS: Knobs = { lookup: "provider", tradingHours: "Default 24 x 7", toOffsetDays: 0 };

// A job's folders are `<job id>-<contract>`. Only folders of that shape, and in them only
// the files a job or the AddOn writes, are ever deleted.
const JOB_FOLDER = /^t[kp]-[a-z0-9]+-[a-z0-9]+-[A-Za-z0-9]+-\d{2}-\d{2}$/;
const OWN_FILE = /^(?:(?:prints|bid|ask)\.\d{4}-\d{2}-\d{2}\.txt\.gz(?:\.part)?|manifest(?:\.\d{4}-\d{2}-\d{2})?\.json(?:\.tmp-[0-9-]+)?)$/;

type BridgeCall = (type: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

export type LakeRun<T> = { report: T } | { refused: string } | { failed: string };

export interface TickFetchDeps {
  request: BridgeCall;
  /** A history request, queued on the prefetch executor's background lane. */
  fetch: BridgeCall;
  isConnected: () => boolean;
  caps: () => string[] | null;
  dropPath: () => string | undefined;
  lakeRoot: () => string;
  calendarFor: (templateName: string) => SessionCalendar;
  cacheFront: (symbol: string, label: string) => string | null;
  runIngest: (folder: string) => Promise<LakeRun<IngestReport>>;
  runProbe: (folder: string) => Promise<LakeRun<ProbeReport>>;
  freeBytes?: (dir: string) => number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type TickDayState =
  | "pending"
  | "fetching"
  | "ingesting"
  | "stored"
  | "already_held"
  | "partial"
  | "empty_stream"
  | "no_rows"
  | "refused"
  | "failed"
  | "cancelled"
  | "held"
  | "not_closed"
  | "closed"
  | "unattested";

const OPEN_STATES: readonly TickDayState[] = ["pending", "fetching", "ingesting"];
const FAILED_STATES: readonly TickDayState[] = ["partial", "empty_stream", "no_rows", "refused", "failed", "unattested"];
const STOPPING_STATES: readonly TickDayState[] = ["refused", "failed"];

export type TickJobState = "running" | "completed" | "completed_with_failures" | "cancelled" | "stopped";

interface JobDay {
  session: string;
  cut: Cut;
  dates: string[];
  contract: string | null;
  contractFrom: "rollover-table" | "override";
  state: TickDayState;
  reason?: string;
  note?: string;
  inFlight?: string;
  take?: number;
  tier?: string | null;
  failing?: string[];
  rows?: Partial<Record<StreamName, number>>;
  folder?: string;
  manifest?: string;
  wallMs?: number;
}

export interface Part {
  contract: string;
  stream: StreamName;
  date: string;
  /** Name in the job folder; null when no row fell inside the day. */
  file: string | null;
  reply: TicksResponseMessage;
}

interface Job {
  id: string;
  owner: string | null;
  symbol: string;
  knobs: Knobs;
  refetch: boolean;
  drop: string;
  state: TickJobState;
  days: JobDay[];
  fetched: Map<string, Part>;
  /** `<contract>|<date>` of refused days, left on disk for inspection. */
  kept: Set<string>;
  requests: number;
  createdAtMs: number;
  finishedAtMs: number | null;
}

export type TickDaySnapshot = Omit<JobDay, "cut" | "wallMs"> & { cut: { from: string; to: string }; wallSecs?: number };

export interface TickJobSnapshot {
  jobId: string;
  owner: string | null;
  symbol: string;
  state: TickJobState;
  knobs: Knobs;
  refetch: boolean;
  counts: Partial<Record<TickDayState, number>>;
  requests: number;
  days: TickDaySnapshot[];
  createdAt: number;
  finishedAt: number | null;
}

export interface StartTicksArgs {
  symbol: string;
  start: string;
  end: string;
  contract?: string;
  refetch?: boolean;
  owner?: string;
}

export interface ProbeTicksArgs {
  contract: string;
  days: string[];
  lookup?: Knobs["lookup"];
  tradingHours?: string;
  toOffsetDays?: Knobs["toOffsetDays"];
}

export type ReplySummary = Omit<TicksResponseMessage, "v" | "id" | "type">;

export interface TickProbeResult {
  contract: string;
  days: string[];
  knobs: Knobs;
  folder: string;
  streams: ProbeReport["streams"];
  probeWallMs: number;
  warnings: string[];
  requests: ReplySummary[];
}

// ---------- plan geometry ----------

export function cutOf(label: string, template: SessionTemplate): Cut {
  const { endUnix } = sessionDayRange(label, template);
  const at = BigInt(endUnix - 1) * TS_PER_SEC;
  const cut = cutsSpanning(at, at, template).find((c) => c.label === label);
  if (!cut) throw new Error(`no session-day cut for ${label}`);
  return cut;
}

const DAY_MS = 86_400_000;
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && isoOf(Date.parse(`${value}T00:00:00Z`) || 0) === value;
}

export function etDatesTouching(cut: Cut): string[] {
  const first = tzParts(cut.from, EXCHANGE_TZ);
  const last = tzParts(cut.to - 1, EXCHANGE_TZ);
  const out: string[] = [];
  const end = Date.UTC(last.year, last.month - 1, last.day);
  for (let t = Date.UTC(first.year, first.month - 1, first.day); t <= end; t += DAY_MS) out.push(isoOf(t));
  return out;
}

export function etMidnight(date: string): bigint {
  const [y, m, d] = date.split("-").map(Number);
  return BigInt(wallClockToUnix(y, m, d, 0, 0, 0, EXCHANGE_TZ)) * TS_PER_SEC;
}

const nextDate = (date: string): string => isoOf(Date.parse(`${date}T00:00:00Z`) + DAY_MS);

function sessionLabels(start: string, end: string, template: SessionTemplate): string[] {
  for (const [name, value] of [["start", start], ["end", end]]) {
    if (!isIsoDate(value)) throw new RefusedError(`${name} "${value}" is not a YYYY-MM-DD date`);
  }
  if (start > end) throw new RefusedError(`start ${start} is after end ${end}`);
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY_MS) {
    const label = isoOf(t);
    try {
      sessionDayRange(label, template);
      out.push(label);
    } catch (err) {
      if (!(err instanceof NoSessionSpanError)) throw err;
    }
  }
  if (out.length === 0) throw new RefusedError(`no session-day between ${start} and ${end}`);
  return out;
}

function contractToken(contract: string): string {
  const p = parseContractName(contract);
  if (!p) throw new RefusedError(`contract "${contract}" is not "<symbol> MM-YY" or "<symbol> MMMYY"`);
  return `${p.symbol}-${String(p.month).padStart(2, "0")}-${String(p.year % 100).padStart(2, "0")}`;
}

export function jobFolder(jobId: string, contract: string): string {
  return `${jobId}-${contractToken(contract)}`;
}

function canonicalOf(contract: string, symbol?: string): string {
  const p = parseContractName(contract);
  if (!p) throw new RefusedError(`contract "${contract}" is not "<symbol> MM-YY" or "<symbol> MMMYY"`);
  if (symbol !== undefined && p.symbol !== symbol) throw new RefusedError(`contract ${contract} is not a ${symbol} contract`);
  const canonical = canonicalContract(contract)!;
  identify(canonical);
  return canonical;
}

// ---------- checks and manifest ----------

export function dayProblems(parts: readonly Part[]): string[] {
  const at = (p: Part) => `${p.stream} ${p.date}`;
  const problems: string[] = [];
  const sim = parts.filter((p) => isSimulatedFeed(p.reply.dataSource));
  if (sim.length > 0) problems.push(`served by the Simulated Data Feed: ${sim.map(at).join(", ")}`);
  // Disconnected, NT8 answers with whatever its local db/tick holds and no error.
  const unfed = parts.filter((p) => p.reply.dataSource.trim() === "");
  if (unfed.length > 0) problems.push(`no data feed was connected in NT8: ${unfed.map(at).join(", ")}`);
  const basis = parts.filter((p) => p.reply.priceBasis !== "as_traded");
  if (basis.length > 0) {
    problems.push(`not as_traded: ${basis.map((p) => `${at(p)} is ${p.reply.priceBasis} (${p.reply.mergePolicy})`).join(", ")}`);
  }
  const bounds = (p: Part) => [String(etMidnight(p.date)), String(etMidnight(nextDate(p.date)))];
  const shifted = parts.filter((p) => p.reply.dayFromTs !== bounds(p)[0] || p.reply.dayToTs !== bounds(p)[1]);
  if (shifted.length > 0) {
    const p = shifted[0];
    problems.push(
      `NT8's time zone (${p.reply.timeZone}) is not US Eastern: ${at(p)} runs ${p.reply.dayFromTs} to ${p.reply.dayToTs}, ` +
        `the Eastern day ${bounds(p).join(" to ")}${shifted.length > 1 ? ` (and ${shifted.length - 1} more)` : ""}`,
    );
  }
  for (const [field, name] of [
    ["tickSize", "tick size"],
    ["timeZone", "time zone"],
    ["lookup", "lookup"],
  ] as const) {
    const seen = [...new Set(parts.map((p) => p.reply[field]))];
    if (seen.length > 1) problems.push(`the responses disagree on ${name}: ${seen.join(", ")}`);
  }
  return problems;
}

/** `parts` in date order. The window is what was asked for. */
export function buildManifest(contract: string, parts: readonly Part[]): AddonManifest {
  const replies = parts.map((p) => p.reply);
  const pick = (xs: string[], older: boolean) =>
    xs.reduce((a, b) => ((BigInt(b) < BigInt(a)) === older ? b : a));
  const distinct = (xs: string[]) => [...new Set(xs)].join(", ");
  const streams: AddonManifest["streams"] = {};
  const files: AddonManifest["parts"] = {};
  for (const s of STREAMS) {
    const own = parts.filter((p) => p.stream === s);
    const filled = own.filter((p) => p.reply.rows > 0);
    streams[s] = {
      rows: own.reduce((n, p) => n + p.reply.rows, 0),
      sizeSum: own.reduce((n, p) => n + BigInt(p.reply.sizeSum), 0n).toString(),
      firstTs: filled.length > 0 ? filled[0].reply.firstTs : null,
      lastTs: filled.length > 0 ? filled[filled.length - 1].reply.lastTs : null,
    };
    files[s] = filled.map((p) => p.file!);
  }
  return {
    instrument: contract,
    tickSize: replies[0].tickSize,
    window: { from: pick(replies.map((r) => r.dayFromTs), true), to: pick(replies.map((r) => r.dayToTs), false) },
    fetchedAt: pick(replies.map((r) => r.fetchedAt), true),
    priceBasis: distinct(replies.map((r) => r.priceBasis)),
    origin: replies[0].lookup as Knobs["lookup"],
    provider: distinct(replies.map((r) => r.dataSource)),
    addonVersion: distinct(replies.map((r) => r.addonVersion)),
    streams,
    parts: files,
  };
}

function summarize(p: Part): ReplySummary {
  const { v: _v, id: _id, type: _type, ...rest } = p.reply;
  return rest;
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? `${code}: ${err.message}` : err.message;
}

export function freeBytesAt(dir: string): number {
  let d = path.resolve(dir);
  while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const s = statfsSync(d);
  return s.bavail * s.bsize;
}

function removeOwnFiles(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (OWN_FILE.test(name)) rmSync(path.join(dir, name), { force: true });
  try {
    rmdirSync(dir);
  } catch {
    // Holds a file no job wrote: left in place.
  }
}

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

// ---------- the manager ----------

/** One job or probe at a time; jobs live in memory, the lake is the durable state. */
export class TickFetchManager {
  private readonly jobs = new Map<string, Job>();
  private readonly settled = new Map<string, Promise<void>>();
  private busy: string | null = null;
  private seq = 0;

  constructor(private readonly deps: TickFetchDeps) {}

  private now(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private log(line: string): void {
    (this.deps.log ?? console.error)(`[tick-fetch] ${line}`);
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private nextId(prefix: "tk" | "tp"): string {
    return `${prefix}-${this.now().toString(36)}-${(++this.seq).toString(36)}`;
  }

  private preflight(): { error: string } | { drop: string } {
    if (!this.deps.isConnected()) {
      return { error: "NinjaTrader is not connected — start NT8 with the McpBridge AddOn, then retry." };
    }
    const unsupported = capsError(TICK_CAP, this.deps.caps());
    if (unsupported !== null) return { error: unsupported };
    const drop = this.deps.dropPath();
    if (!drop) {
      return {
        error:
          "NT_TICK_DROP_PATH is not set. Set it in .env.local to this machine's path to the AddOn's drop folder, <NT8 user data dir>/mcp-ticks.noindex, then restart the hub (npm stop).",
      };
    }
    if (this.busy !== null) {
      return { error: `${this.busy} is still running; one tick fetch at a time — poll prefetch_ticks_status, or cancel it.` };
    }
    return { drop: path.resolve(drop) };
  }

  async start(args: StartTicksArgs): Promise<{ error: string } | { job: TickJobSnapshot }> {
    const pre = this.preflight();
    if ("error" in pre) return pre;
    if (!SUPPORTED_SYMBOLS.includes(args.symbol)) {
      return { error: `Unsupported symbol: ${args.symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}` };
    }
    const id = this.nextId("tk");
    this.busy = `tick job ${id}`;
    try {
      const template = getInstrumentConfig(args.symbol).session;
      const labels = sessionLabels(args.start, args.end, template);
      const override = args.contract !== undefined ? canonicalOf(args.contract, args.symbol) : null;
      let windows: RolloverWindow[] = [];
      if (override === null) {
        const read = await this.rolloverTable(args.symbol);
        if ("error" in read) {
          this.busy = null;
          return read;
        }
        windows = read.windows;
      }
      const job: Job = {
        id,
        owner: args.owner ?? null,
        symbol: args.symbol,
        knobs: { ...JOB_KNOBS },
        refetch: args.refetch === true,
        drop: pre.drop,
        state: "running",
        days: labels.map((label) => this.planDay(label, args.symbol, template, windows, override, args.refetch === true)),
        fetched: new Map(),
        kept: new Set(),
        requests: 0,
        createdAtMs: this.now(),
        finishedAtMs: null,
      };
      this.jobs.set(id, job);
      const pending = job.days.filter((d) => d.state === "pending").length;
      this.log(`${id} started: ${args.symbol} ${args.start}..${args.end}, ${pending} of ${job.days.length} session-day(s) to fetch`);
      this.settled.set(id, this.run(job));
      return { job: this.snapshot(job) };
    } catch (err) {
      this.busy = null;
      if (err instanceof RefusedError) return { error: err.message };
      throw err;
    }
  }

  private async rolloverTable(symbol: string): Promise<{ error: string } | { windows: RolloverWindow[] }> {
    let reply: unknown;
    try {
      reply = await this.deps.request("resolve_instrument", { symbol }, RESOLVE_TIMEOUT_MS);
    } catch (err) {
      return { error: `could not read NT8's rollover table for ${symbol}: ${describeError(err)}` };
    }
    if (!isInboundType(reply, "resolve_instrument_result")) {
      return { error: `unexpected reply to resolve_instrument for ${symbol}` };
    }
    if (reply.rollovers == null) {
      return {
        error: `NT8 sent no rollover table for ${symbol} (unreadable, or nothing resolved): pass contract to name the contract yourself`,
      };
    }
    return { windows: windowsFromResponse(reply.rollovers, symbol) };
  }

  private planDay(
    label: string,
    symbol: string,
    template: SessionTemplate,
    windows: RolloverWindow[],
    override: string | null,
    refetch: boolean,
  ): JobDay {
    const cut = cutOf(label, template);
    const contract = override ?? contractForLabel(windows, symbol, label);
    const day: JobDay = {
      session: label,
      cut,
      dates: etDatesTouching(cut),
      contract,
      contractFrom: override !== null ? "override" : "rollover-table",
      state: "pending",
    };
    if (cut.to > Math.floor(this.now() / 1000)) {
      return { ...day, state: "not_closed", reason: `closes ${formatExchangeTime(cut.to)} ET` };
    }
    const cal = this.deps.calendarFor(template.name).get(label);
    if (cal?.kind === "closed") return { ...day, state: "closed", reason: `calendar: ${cal.description ?? "closed"}` };
    if (contract === null) {
      const why =
        windows.length === 0
          ? `NT8's rollover table for ${symbol} is empty`
          : `no rollover window covers ${label} (NT8's table starts ${windows[0].rolloverDate})`;
      return { ...day, state: "unattested", reason: `${why}; pass contract to name it` };
    }
    const front = this.deps.cacheFront(symbol, label);
    if (front !== null && !sameContract(front, contract)) day.note = `the cache's front contract for this day is ${front}`;
    const takes = listTakes(sessionDir(this.deps.lakeRoot(), identify(contract), label));
    if (takes.length > 0 && !refetch) return { ...day, state: "held", reason: `take ${takes.join(", ")} already in the lake` };
    return day;
  }

  private async run(job: Job): Promise<void> {
    try {
      this.sweep(job.drop);
      let failedInARow = 0;
      for (const day of job.days) {
        if (day.state !== "pending") continue;
        if (job.state === "cancelled") {
          day.state = "cancelled";
          continue;
        }
        if (job.state === "stopped") {
          Object.assign(day, { state: "cancelled", reason: `not fetched: the job stopped after ${MAX_FAILED_IN_A_ROW} days in a row ended refused or failed` });
          continue;
        }
        const t0 = this.now();
        await this.runDay(job, day);
        day.wallMs = this.now() - t0;
        this.log(`${job.id} ${day.session} ${day.contract}: ${day.state}${day.reason ? ` — ${day.reason}` : ""}`);
        this.release(job, day.contract!);
        failedInARow = STOPPING_STATES.includes(day.state) ? failedInARow + 1 : 0;
        if (failedInARow === MAX_FAILED_IN_A_ROW && job.state === "running") {
          job.state = "stopped";
          this.log(`${job.id} stopped: ${MAX_FAILED_IN_A_ROW} days in a row ended refused or failed`);
        }
      }
    } catch (err) {
      for (const d of job.days) {
        if (OPEN_STATES.includes(d.state)) Object.assign(d, { state: "failed", reason: `internal error: ${describeError(err)}` });
      }
      this.log(`${job.id} stopped by an internal error: ${err instanceof Error ? err.stack : err}`);
    } finally {
      this.finish(job);
    }
  }

  private async runDay(job: Job, day: JobDay): Promise<void> {
    const contract = day.contract!;
    const dir = path.join(job.drop, jobFolder(job.id, contract));
    const free = (this.deps.freeBytes ?? freeBytesAt)(job.drop);
    if (free < MIN_FREE_BYTES) {
      Object.assign(day, { state: "failed", reason: `${gib(free)} GB free at ${job.drop}; a day needs ${gib(MIN_FREE_BYTES)} GB` });
      return;
    }
    day.state = "fetching";
    const parts: Part[] = [];
    for (const date of day.dates) {
      for (const stream of STREAMS) {
        const key = `${contract}|${date}|${stream}`;
        let part = job.fetched.get(key);
        if (!part) {
          if (job.state === "cancelled") {
            Object.assign(day, { state: "cancelled", inFlight: undefined });
            return;
          }
          let fetched: Part | null;
          try {
            fetched = await this.fetchWhenFree(job, day, path.basename(dir), contract, stream, date);
          } catch (err) {
            day.inFlight = undefined;
            if (err instanceof RefusedError) this.refuse(job, day, dir, err.message);
            else Object.assign(day, { state: "failed", reason: describeError(err) });
            return;
          }
          if (fetched === null) {
            Object.assign(day, { state: "cancelled", inFlight: undefined });
            return;
          }
          part = fetched;
          job.fetched.set(key, part);
        }
        parts.push(part);
      }
    }
    day.inFlight = undefined;
    const problems = dayProblems(parts);
    if (problems.length > 0) {
      this.refuse(job, day, dir, problems.join("; "));
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, MANIFEST_FILE), buildManifest(contract, parts));
    day.state = "ingesting";
    const run = await this.deps.runIngest(dir);
    if ("report" in run) {
      this.applyReport(day, contract, run.report);
      return;
    }
    const named = path.join(dir, `manifest.${day.session}.json`);
    copyFileSync(path.join(dir, MANIFEST_FILE), named);
    if ("refused" in run) this.refuse(job, day, dir, run.refused, named);
    else this.refuse(job, day, dir, run.failed, named, "failed");
  }

  private async fetchWhenFree(
    job: Job,
    day: JobDay,
    folder: string,
    contract: string,
    stream: StreamName,
    date: string,
  ): Promise<Part | null> {
    for (let waitedMs = 0; ; waitedMs += BUSY_RETRY_MS) {
      day.inFlight = `${stream} ${date}`;
      job.requests++;
      try {
        return await this.fetchPart(job.drop, folder, contract, stream, date, job.knobs);
      } catch (err) {
        if (!(err instanceof Error) || (err as { code?: unknown }).code !== "busy") throw err;
        if (waitedMs >= BUSY_WAIT_MS) throw new Error(`${describeError(err)}; still busy after ${BUSY_WAIT_MS / 60_000} min`);
        day.inFlight = `${stream} ${date}, waiting: ${err.message}`;
      }
      await this.sleep(BUSY_RETRY_MS);
      if (job.state === "cancelled") return null;
    }
  }

  private async fetchPart(
    drop: string,
    folder: string,
    contract: string,
    stream: StreamName,
    date: string,
    knobs: Knobs,
  ): Promise<Part> {
    const reply = await this.deps.fetch(
      "request_ticks",
      { instrument: contract, stream, day: date, job: folder, ...knobs },
      STREAM_TIMEOUT_MS,
    );
    if (!isInboundType(reply, "ticks_response")) throw new Error(`unexpected reply to request_ticks ${stream} ${date}`);
    if (!sameContract(reply.instrument, contract)) {
      throw new RefusedError(`asked for ${contract}, the AddOn answered for ${reply.instrument}`);
    }
    if (reply.stream !== stream || reply.day !== date) {
      throw new RefusedError(`asked for ${stream} ${date}, the AddOn answered ${reply.stream} ${reply.day}`);
    }
    if (reply.addonVersion !== TICKS_ADDON_VERSION) {
      throw new RefusedError(
        `the AddOn wrote tick files in format ${reply.addonVersion}; this hub reads format ${TICKS_ADDON_VERSION}: recompile ninja-addon/addons/mcp-bridge.cs (SETUP.md step 12)`,
      );
    }
    if (reply.rows === 0) return { contract, stream, date, file: null, reply };
    const name = partFileName(stream, date);
    const seen = path.join(drop, folder, name);
    if (!existsSync(seen)) {
      throw new RefusedError(
        `the AddOn wrote ${reply.file ?? name}, but the hub finds no ${seen}: NT_TICK_DROP_PATH (${drop}) must be this machine's path to the AddOn's <UserDataDir>/mcp-ticks.noindex`,
      );
    }
    return { contract, stream, date, file: name, reply };
  }

  private refuse(
    job: Job,
    day: JobDay,
    dir: string,
    reason: string,
    manifest?: string,
    state: "refused" | "failed" = "refused",
  ): void {
    Object.assign(day, { state, reason, folder: dir });
    if (manifest) day.manifest = manifest;
    for (const date of day.dates) job.kept.add(`${day.contract}|${date}`);
  }

  private applyReport(day: JobDay, contract: string, report: IngestReport): void {
    const want = identify(contract).contract;
    if (report.contract !== want) {
      Object.assign(day, { state: "failed", reason: `the ingest read ${report.contract}, not ${want}` });
      return;
    }
    const line = report.days.find((d) => d.session === day.session);
    if (!line) {
      Object.assign(day, { state: "no_rows", reason: "no stream has a row in this session-day" });
      return;
    }
    day.state = line.status;
    day.rows = line.rows;
    if (line.take !== undefined) day.take = line.take;
    if (line.tier !== undefined) day.tier = line.tier;
    if (line.failing !== undefined) day.failing = line.failing;
    if (line.reason !== undefined) day.reason = line.reason;
  }

  private release(job: Job, contract: string): void {
    const needed = new Set<string>();
    for (const d of job.days) {
      if (d.contract === contract && d.state === "pending") for (const date of d.dates) needed.add(date);
    }
    for (const [key, part] of job.fetched) {
      if (part.contract !== contract || needed.has(part.date) || job.kept.has(`${contract}|${part.date}`)) continue;
      if (part.file) rmSync(path.join(job.drop, jobFolder(job.id, contract), part.file), { force: true });
      job.fetched.delete(key);
    }
  }

  private finish(job: Job): void {
    for (const d of job.days) {
      if (OPEN_STATES.includes(d.state)) Object.assign(d, { state: "cancelled", inFlight: undefined });
    }
    const contracts = new Set(job.days.filter((d) => d.contract !== null).map((d) => d.contract!));
    for (const contract of contracts) {
      try {
        this.release(job, contract);
        const dir = path.join(job.drop, jobFolder(job.id, contract));
        if ([...job.kept].some((k) => k.startsWith(`${contract}|`))) rmSync(path.join(dir, MANIFEST_FILE), { force: true });
        else removeOwnFiles(dir);
      } catch (err) {
        this.log(`${job.id}: cleanup of ${contract} failed: ${describeError(err)}`);
      }
    }
    if (job.state === "running") {
      job.state = job.days.some((d) => FAILED_STATES.includes(d.state)) ? "completed_with_failures" : "completed";
    }
    job.finishedAtMs = this.now();
    this.busy = null;
    const s = this.snapshot(job);
    this.log(`${job.id} ${job.state}: ${Object.entries(s.counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
    this.prune();
  }

  private sweep(drop: string): void {
    if (!existsSync(drop)) return;
    const cutoff = this.now() - STALE_FOLDER_MS;
    for (const e of readdirSync(drop, { withFileTypes: true })) {
      if (!e.isDirectory() || !JOB_FOLDER.test(e.name)) continue;
      const dir = path.join(drop, e.name);
      try {
        if (statSync(dir).mtimeMs >= cutoff) continue;
        removeOwnFiles(dir);
        this.log(`removed the stale folder ${dir}`);
      } catch (err) {
        this.log(`could not remove the stale folder ${dir}: ${describeError(err)}`);
      }
    }
  }

  private prune(): void {
    const done = [...this.jobs.values()]
      .filter((j) => j.state !== "running")
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    for (const j of done.slice(MAX_RETAINED_JOBS)) {
      this.jobs.delete(j.id);
      this.settled.delete(j.id);
    }
  }

  /** What a hub shutdown would end. */
  activity(): string | null {
    if (this.busy === null) return null;
    const job = [...this.jobs.values()].find((j) => j.finishedAtMs === null);
    if (!job) return `${this.busy} is running`;
    const finished = job.days.filter((d) => !OPEN_STATES.includes(d.state)).length;
    const now = job.days.find((d) => d.state === "fetching" || d.state === "ingesting");
    const doing = now ? `, ${now.state} ${now.inFlight ?? now.session}` : "";
    return `tick job ${job.id} is running (${job.symbol}, ${finished} of ${job.days.length} session-days finished${doing})`;
  }

  status(): { jobs: TickJobSnapshot[] };
  status(jobId: string): { error: string } | { job: TickJobSnapshot };
  status(jobId?: string): { jobs: TickJobSnapshot[] } | { error: string } | { job: TickJobSnapshot } {
    if (jobId === undefined) {
      return { jobs: [...this.jobs.values()].sort((a, b) => b.createdAtMs - a.createdAtMs).map((j) => this.snapshot(j)) };
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      return { error: `unknown tick job "${jobId}" — jobs do not survive a hub restart; the lake does, so re-issuing prefetch_ticks fetches only what it lacks` };
    }
    return { job: this.snapshot(job) };
  }

  cancel(jobId: string, opts: { by?: string; force?: boolean } = {}): { error: string } | { job: TickJobSnapshot } {
    const job = this.jobs.get(jobId);
    if (!job) return { error: `unknown tick job "${jobId}"` };
    if (job.owner !== null && opts.by !== undefined && job.owner !== opts.by && !opts.force) {
      return { error: `tick job "${jobId}" was started by another conversation (${job.owner}); pass force:true to cancel it anyway` };
    }
    if (job.state === "running") job.state = "cancelled";
    return { job: this.snapshot(job) };
  }

  whenSettled(jobId: string): Promise<void> {
    return this.settled.get(jobId) ?? Promise.reject(new Error(`unknown tick job "${jobId}"`));
  }

  private snapshot(job: Job): TickJobSnapshot {
    const counts: Partial<Record<TickDayState, number>> = {};
    for (const d of job.days) counts[d.state] = (counts[d.state] ?? 0) + 1;
    return {
      jobId: job.id,
      owner: job.owner,
      symbol: job.symbol,
      state: job.state,
      knobs: job.knobs,
      refetch: job.refetch,
      counts,
      requests: job.requests,
      days: job.days.map(({ cut, wallMs, ...d }) => ({
        ...d,
        cut: { from: `${formatExchangeTime(cut.from)} ET`, to: `${formatExchangeTime(cut.to)} ET` },
        ...(wallMs !== undefined && { wallSecs: Math.round(wallMs / 100) / 10 }),
      })),
      createdAt: Math.floor(job.createdAtMs / 1000),
      finishedAt: job.finishedAtMs === null ? null : Math.floor(job.finishedAtMs / 1000),
    };
  }

  /** Stores nothing in the lake; the text files stay until a job or probe starts 24 h later. */
  async probe(args: ProbeTicksArgs): Promise<{ error: string; requests?: ReplySummary[] } | { probe: TickProbeResult }> {
    const pre = this.preflight();
    if ("error" in pre) return pre;
    let contract: string;
    try {
      contract = canonicalOf(args.contract);
    } catch (err) {
      return { error: describeError(err) };
    }
    const days = [...new Set(args.days)].sort();
    const bad = days.find((d) => !isIsoDate(d));
    if (bad !== undefined) return { error: `day "${bad}" is not a YYYY-MM-DD date` };
    if (days.length === 0 || days.length > MAX_PROBE_DAYS) {
      return { error: `probe 1 to ${MAX_PROBE_DAYS} days, not ${days.length}: the probe holds every day it fetches in memory at once` };
    }
    const knobs: Knobs = {
      lookup: args.lookup ?? JOB_KNOBS.lookup,
      tradingHours: args.tradingHours ?? JOB_KNOBS.tradingHours,
      toOffsetDays: args.toOffsetDays ?? JOB_KNOBS.toOffsetDays,
    };
    const id = this.nextId("tp");
    const folder = jobFolder(id, contract);
    const dir = path.join(pre.drop, folder);
    this.busy = `tick probe ${id}`;
    try {
      this.sweep(pre.drop);
      const free = (this.deps.freeBytes ?? freeBytesAt)(pre.drop);
      if (free < MIN_FREE_BYTES) return { error: `${gib(free)} GB free at ${pre.drop}; a probe needs ${gib(MIN_FREE_BYTES)} GB` };
      const parts: Part[] = [];
      for (const date of days) {
        for (const stream of STREAMS) {
          try {
            parts.push(await this.fetchPart(pre.drop, folder, contract, stream, date, knobs));
          } catch (err) {
            return { error: `${stream} ${date}: ${describeError(err)}`, requests: parts.map(summarize) };
          }
        }
      }
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(path.join(dir, MANIFEST_FILE), buildManifest(contract, parts));
      const run = await this.deps.runProbe(dir);
      if (!("report" in run)) {
        return { error: `nt8-lake probe: ${"refused" in run ? run.refused : run.failed}`, requests: parts.map(summarize) };
      }
      return {
        probe: {
          contract,
          days,
          knobs,
          folder: dir,
          streams: run.report.streams,
          probeWallMs: run.report.wallMs,
          warnings: dayProblems(parts),
          requests: parts.map(summarize),
        },
      };
    } finally {
      this.busy = null;
    }
  }
}

// ---------- the lake CLI as a child process ----------

const LAKE_SCRIPT = fileURLToPath(new URL("../scripts/nt8-lake.js", import.meta.url));

/** The hub never loads DuckDB itself. */
export function runLakeCli<T>(args: string[], opts: { script?: string; timeoutMs?: number } = {}): Promise<LakeRun<T>> {
  const script = opts.script ?? LAKE_SCRIPT;
  if (!existsSync(script)) return Promise.resolve({ failed: `${script} is missing: run npm run build` });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_LOW);
      } catch {
        // Already exited: the close handler reports it.
      }
    }
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (s: string) => (out += s));
    child.stderr.setEncoding("utf8").on("data", (s: string) => (err = (err + s).slice(-4000)));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? LAKE_RUN_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ failed: `could not start ${script}: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Into the hub log, where a broken stale lock would otherwise leave no trace.
      if (err.trim() !== "") console.error(`[nt8-lake ${args[0]}] ${err.trim()}`);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(out.trim().split("\n").pop() ?? "");
      } catch {
        // Not JSON: reported with the exit status below.
      }
      if (parsed !== null && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (typeof p.refused === "string") return resolve({ refused: p.refused });
        if (typeof p.failed === "string") return resolve({ failed: p.failed });
        if (code === 0) return resolve({ report: parsed as T });
      }
      const lines = (err.trim() || out.trim() || "no output").split("\n").map((l) => l.trim()).filter(Boolean);
      const why = lines.find((l) => /^\w*(Error|Exception)\b/.test(l)) ?? lines.slice(-3).join(" | ");
      resolve({ failed: `nt8-lake ${args[0]} exited ${code ?? signal}: ${why}` });
    });
  });
}
