import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname, uptime } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTickSize } from "../core/instruments/tick-size.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { sessionDaysOverlapping } from "../core/sessions/session-day.js";
import type { SessionCalendar } from "../core/sessions/calendar.js";
import { wallClockToUnix } from "../core/time.js";
import { cacheReferenceBars, openCache, readCalendar } from "./cache.js";
import { checksPath, computeChecks, type CheckResult, type ReferenceBars } from "./checks.js";
import { rows, withEngine, type Engine } from "./engine.js";
import { dayState, isWaived, readDay, writeDay, type DayFile, type DayState, type Tier } from "./labels.js";
import {
  assertLabel,
  identify,
  identifyContract,
  lakeRoot,
  listContracts,
  listDays,
  listTakes,
  listTempDirs,
  LOCK_FILE,
  sessionDir,
  streamFile,
  takeDir,
  type Identity,
} from "./layout.js";
import { fingerprint, readFooter, readStream, sha256File } from "./reader.js";
import { cutsSpanning, proveWhole, TS_PER_SEC, type Cut, type StreamSpan } from "./session-cut.js";
import { RefusedError, UNATTESTED, type OpenSource, type Source, type StreamName } from "./source.js";
import {
  checkManifest,
  freeStaged,
  parseTickSize,
  selectInput,
  stage,
  writeJsonAtomic,
  writeStreamFile,
  writeTake,
  type SelectedInput,
  type TakeFile,
  type TickSize,
} from "./writer.js";

export interface LakeContext {
  root: string;
  calendarFor(templateName: string): SessionCalendar;
  referenceBars: ReferenceBars;
}

export function defaultContext(): LakeContext & { close(): void } {
  const cache = openCache();
  return {
    root: lakeRoot(),
    calendarFor: (name) => readCalendar(cache, name),
    referenceBars: cacheReferenceBars(cache),
    close: () => cache?.close(),
  };
}

// ---------- lock ----------

interface LockHolder {
  pid: number;
  host: string;
  command: string;
  startedAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A clock step after boot moves the computed boot time; the margin absorbs it.
const BOOT_MARGIN_MS = 60_000;

/** Why this host's holder is certainly gone, or null while it may still run. */
function staleBecause(holder: Partial<LockHolder>): string | null {
  if (holder.host !== hostname()) return null;
  if (typeof holder.pid === "number" && !pidAlive(holder.pid)) return "that process is gone";
  // After a reboot the pid may belong to another process.
  const bootMs = Date.now() - uptime() * 1000;
  if (Date.parse(holder.startedAt ?? "") < bootMs - BOOT_MARGIN_MS) return "it was taken before the last boot";
  return null;
}

function takeLock(file: string): number {
  for (let attempt = 0; ; attempt++) {
    try {
      return openSync(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder: Partial<LockHolder> = {};
    try {
      holder = JSON.parse(readFileSync(file, "utf-8")) as LockHolder;
    } catch {
      // Unreadable lock: still held.
    }
    const who = `${holder.command ?? "?"}, pid ${holder.pid ?? "?"} on ${holder.host ?? "?"} since ${holder.startedAt ?? "?"}`;
    const stale = attempt === 0 ? staleBecause(holder) : null;
    if (stale === null) throw new RefusedError(`another nt8-lake job holds the lake (${who})`);
    rmSync(file, { force: true });
    console.error(`[nt8-lake] broke the lock left by ${who}: ${stale}`);
  }
}

/** One writer at a time across processes. */
export async function withLock<T>(root: string, command: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, LOCK_FILE);
  const fd = takeLock(file);
  try {
    const holder: LockHolder = { pid: process.pid, host: hostname(), command, startedAt: new Date().toISOString() };
    writeSync(fd, JSON.stringify(holder) + "\n");
    closeSync(fd);
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

// ---------- sources ----------

/** Sources are loaded by name so removing one never breaks the rest. */
export async function openSource(kind: string, folder: string): Promise<Source> {
  if (!/^[a-z0-9-]+$/.test(kind)) throw new RefusedError(`bad source name "${kind}"`);
  // .ts when run from source under vitest.
  const file = [".js", ".ts"]
    .map((ext) => fileURLToPath(new URL(`./sources/${kind}${ext}`, import.meta.url)))
    .find((f) => existsSync(f));
  if (!file) throw new RefusedError(`unknown source "${kind}"`);
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { openSource?: OpenSource };
  if (typeof mod.openSource !== "function") throw new RefusedError(`source "${kind}" exports no openSource`);
  return mod.openSource(folder);
}

// ---------- ingest ----------

export interface IngestDay {
  session: string;
  status: "stored" | "already_held" | "partial" | "empty_stream";
  take?: number;
  rows: Partial<Record<StreamName, number>>;
  reason?: string;
  tier?: Tier | null;
  failing?: string[];
}

export interface IngestReport {
  source: string;
  instrument: string;
  contract: string;
  rows: Partial<Record<StreamName, number>>;
  days: IngestDay[];
  wallMs: number;
}

function readTake(dir: string): TakeFile {
  return JSON.parse(readFileSync(path.join(dir, "take.json"), "utf-8")) as TakeFile;
}

function sameTake(a: TakeFile, inputs: Partial<Record<StreamName, { rows: number; fingerprint: string }>>): boolean {
  const keys = Object.keys(inputs).sort();
  if (Object.keys(a.streams).sort().join() !== keys.join()) return false;
  return keys.every((k) => {
    const s = a.streams[k as StreamName]!;
    const i = inputs[k as StreamName]!;
    return s.rows === i.rows && s.fingerprint === i.fingerprint;
  });
}

function checkContext(ctx: LakeContext, id: Identity) {
  const template = getInstrumentConfig(id.symbol).session;
  return { template, calendar: ctx.calendarFor(template.name), referenceBars: ctx.referenceBars };
}

function tickSizeOf(source: Source, id: Identity): { tick: TickSize; from: TakeFile["tickSizeFrom"] } {
  const registry = parseTickSize(String(getTickSize(id.symbol)));
  if (source.manifest.tickSize === UNATTESTED) return { tick: registry, from: "registry" };
  const tick = parseTickSize(source.manifest.tickSize);
  if (tick.text !== registry.text) {
    throw new RefusedError(`NT8 tick size ${tick.text} differs from the registry's ${registry.text} for ${id.symbol}`);
  }
  return { tick, from: "manifest" };
}

export async function ingest(ctx: LakeContext, source: Source): Promise<IngestReport> {
  const started = Date.now();
  const id = identify(source.instrument);
  const { tick, from: tickFrom } = tickSizeOf(source, id);
  const checkCtx = checkContext(ctx, id);

  return withLock(ctx.root, `ingest ${source.kind}`, () =>
    withEngine(async (engine) => {
      const stats = await stage(engine, source, tick);
      checkManifest(source, stats);
      const streams = source.streams;
      const report: IngestReport = {
        source: source.kind,
        instrument: id.instrument,
        contract: id.contract,
        rows: Object.fromEntries(streams.map((s) => [s, stats[s]!.rows])),
        days: [],
        wallMs: 0,
      };
      const filled = streams.filter((s) => stats[s]!.rows > 0);
      if (filled.length === 0) return { ...report, wallMs: Date.now() - started };
      const minTs = filled.map((s) => stats[s]!.minTs).reduce((a, b) => (b < a ? b : a));
      const maxTs = filled.map((s) => stats[s]!.maxTs).reduce((a, b) => (b > a ? b : a));
      const spans: Partial<Record<StreamName, StreamSpan>> = Object.fromEntries(
        streams.map((s) => [s, stats[s]!.rows > 0 ? stats[s]! : { minTs: maxTs + 1n, maxTs: minTs - 1n }]),
      );

      // Count every cut and select every stored cut's rows before the staged rows are freed.
      const planned: (IngestDay | { cut: Cut; by: TakeFile["wholeBy"]; inputs: Inputs })[] = [];
      for (const cut of cutsSpanning(minTs, maxTs, checkCtx.template)) {
        const counts = await countIn(engine, streams, cut);
        if (streams.every((s) => counts[s] === 0)) continue;
        const proof = proveWhole(cut, source.manifest, spans);
        if (!proof.whole) {
          planned.push({ session: cut.label, status: "partial", rows: counts, reason: proof.reason });
          continue;
        }
        const empty = streams.find((s) => counts[s] === 0);
        if (empty) {
          planned.push({ session: cut.label, status: "empty_stream", rows: counts, reason: `${empty} has no rows in this session-day` });
          continue;
        }
        const inputs: Inputs = {};
        for (const s of streams) inputs[s] = await selectInput(engine, s, cut, `inp_${planned.length}_${s}`);
        planned.push({ cut, by: proof.by, inputs });
      }
      await freeStaged(engine, streams);
      for (const p of planned) {
        report.days.push("cut" in p ? await storeDay(ctx, engine, id, source, p.cut, p.inputs, tick.text, tickFrom, p.by, checkCtx) : p);
      }
      report.wallMs = Date.now() - started;
      return report;
    }),
  );
}

type Inputs = Partial<Record<StreamName, SelectedInput>>;

async function countIn(engine: Engine, streams: readonly StreamName[], cut: Cut): Promise<Partial<Record<StreamName, number>>> {
  const out: Partial<Record<StreamName, number>> = {};
  for (const s of streams) {
    const [r] = await rows(
      engine.con,
      `SELECT count(*)::BIGINT AS n FROM can_${s} WHERE ts >= ${BigInt(cut.from) * TS_PER_SEC} AND ts < ${BigInt(cut.to) * TS_PER_SEC}`,
    );
    out[s] = Number(r.n);
  }
  return out;
}

async function storeDay(
  ctx: LakeContext,
  engine: Engine,
  id: Identity,
  source: Source,
  cut: Cut,
  inputs: Inputs,
  tickText: string,
  tickFrom: TakeFile["tickSizeFrom"],
  wholeBy: TakeFile["wholeBy"],
  checkCtx: ReturnType<typeof checkContext>,
): Promise<IngestDay> {
  const counts = Object.fromEntries(source.streams.map((s) => [s, inputs[s]!.rows]));
  const sessionPath = sessionDir(ctx.root, id, cut.label);
  const takes = listTakes(sessionPath);
  for (const t of takes) {
    if (sameTake(readTake(takeDir(ctx.root, id, cut.label, t)), inputs)) {
      for (const s of source.streams) await engine.con.run(`DROP TABLE ${inputs[s]!.table}`);
      return { session: cut.label, status: "already_held", take: t, rows: counts };
    }
  }
  const take = takes.length === 0 ? 1 : takes[takes.length - 1] + 1;
  await writeTake(
    engine,
    sessionPath,
    {
      format: "ticks.v1",
      instrument: id.instrument,
      symbol: id.symbol,
      contract: id.contract,
      session: cut.label,
      take,
      cut: { from: cut.from, to: cut.to },
      tickSize: tickText,
      tickSizeFrom: tickFrom,
      wholeBy,
      source: { kind: source.kind, manifest: source.manifest },
    },
    inputs,
    async (tmpDir, written) => {
      writeJsonAtomic(checksPath(tmpDir), await computeChecks(engine, tmpDir, written, checkCtx));
    },
  );
  if (takes.length === 0) writeDay(sessionPath, { selection: { take, by: "first", at: new Date().toISOString() } });
  const state = dayState(sessionPath);
  return {
    session: cut.label,
    status: "stored",
    take,
    rows: counts,
    tier: state.tier,
    failing: state.failing.map((r) => r.id),
  };
}

// ---------- probe ----------

export interface ProbeStream {
  rows: number;
  bytes: number;
  fingerprint: string;
}

export interface ProbeReport {
  source: string;
  instrument: string;
  streams: Partial<Record<StreamName, ProbeStream>>;
  wallMs: number;
}

/** Each whole stream through the stream writer, no session cut. Stores nothing. */
export async function probe(ctx: LakeContext, source: Source): Promise<ProbeReport> {
  const started = Date.now();
  const id = identify(source.instrument);
  const { tick } = tickSizeOf(source, id);
  const dir = path.join(ctx.root, `.tmp-probe-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    return await withEngine(async (engine) => {
      const stats = await stage(engine, source, tick);
      checkManifest(source, stats);
      const streams: ProbeReport["streams"] = {};
      for (const stream of source.streams) {
        const input = await selectInput(engine, stream, null);
        await freeStaged(engine, [stream]);
        if (input.rows === 0) {
          streams[stream] = { rows: 0, bytes: 0, fingerprint: input.fingerprint };
          continue;
        }
        const w = await writeStreamFile(engine, stream, input.table, streamFile(dir, stream), {
          instrument: id.instrument,
          symbol: id.symbol,
          session: "probe",
          take: 0,
          tickSize: tick.text,
          cutFrom: "none",
          cutTo: "none",
          source: source.kind,
          priceBasis: source.manifest.priceBasis,
        });
        streams[stream] = { rows: w.rows, bytes: w.bytes, fingerprint: w.fingerprint };
      }
      return { source: source.kind, instrument: id.instrument, streams, wallMs: Date.now() - started };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- status / show ----------

export interface StatusLine {
  contract: string;
  session: string;
  state: "stored" | "missing" | "closed";
  take?: number | null;
  takes?: number;
  tier?: Tier | null;
  failing?: string[];
  note?: string;
}

function labelBounds(from: string, to: string): [number, number] {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return [wallClockToUnix(fy, fm, fd, 0, 0, 0, "UTC") - 2 * 86_400, wallClockToUnix(ty, tm, td, 23, 59, 59, "UTC") + 2 * 86_400];
}

export function status(ctx: LakeContext, opts: { contract?: string; from?: string; to?: string } = {}): StatusLine[] {
  const ids = opts.contract ? [identifyContract(opts.contract)] : listContracts(ctx.root);
  const out: StatusLine[] = [];
  for (const id of ids) {
    const stored = new Map(listDays(ctx.root, id).map((d) => [d.label, d]));
    if (stored.size === 0) continue;
    const labels = [...stored.keys()];
    const from = opts.from ?? labels[0];
    const to = opts.to ?? labels[labels.length - 1];
    const { template, calendar } = checkContext(ctx, id);
    const [lo, hi] = labelBounds(from, to);
    const expected = new Set(
      sessionDaysOverlapping(lo, hi, template)
        .map((d) => d.label)
        .filter((l) => l >= from && l <= to),
    );
    for (const l of labels) if (l >= from && l <= to) expected.add(l);
    for (const label of [...expected].sort()) {
      const day = stored.get(label);
      const cal = calendar.get(label);
      if (day) {
        const st = dayState(day.dir);
        out.push({
          contract: id.contract,
          session: label,
          state: "stored",
          take: st.selected,
          takes: st.takes.length,
          tier: st.tier,
          failing: st.failing.map((r) => r.id),
          ...(cal?.kind === "closed" && { note: `calendar: closed (${cal.description ?? ""})` }),
        });
      } else if (cal?.kind === "closed") {
        out.push({ contract: id.contract, session: label, state: "closed", note: cal.description });
      } else {
        out.push({ contract: id.contract, session: label, state: "missing" });
      }
    }
  }
  return out;
}

export interface ReviewSheet {
  contract: string;
  instrument: string;
  session: string;
  state: DayState;
  takes: { take: number; writtenAt: string; source: string; streams: TakeFile["streams"] }[];
  selectedTake: TakeFile | null;
}

export function show(ctx: LakeContext, contract: string, session: string): ReviewSheet {
  assertLabel(session);
  const id = identifyContract(contract);
  const dir = sessionDir(ctx.root, id, session);
  const state = dayState(dir);
  if (state.takes.length === 0) throw new RefusedError(`${id.contract} ${session} is not in the lake`);
  const takes = state.takes.map((t) => {
    const tf = readTake(takeDir(ctx.root, id, session, t));
    return { take: t, writtenAt: tf.writtenAt, source: tf.source.kind, streams: tf.streams };
  });
  const selectedTake = state.selected !== null ? readTake(takeDir(ctx.root, id, session, state.selected)) : null;
  return { contract: id.contract, instrument: id.instrument, session, state, takes, selectedTake };
}

// ---------- verify / recheck ----------

interface StoredTake {
  id: Identity;
  label: string;
  take: number;
  dir: string;
}

function storedTakes(root: string, filter: { contract?: string; session?: string } = {}): StoredTake[] {
  const ids = filter.contract ? [identifyContract(filter.contract)] : listContracts(root);
  const out: StoredTake[] = [];
  for (const id of ids) {
    for (const day of listDays(root, id)) {
      if (filter.session && day.label !== filter.session) continue;
      for (const t of listTakes(day.dir)) out.push({ id, label: day.label, take: t, dir: takeDir(root, id, day.label, t) });
    }
  }
  return out;
}

export interface VerifyReport {
  takes: { contract: string; session: string; take: number; problems: string[] }[];
  leftovers: string[];
  ok: boolean;
}

export async function verify(ctx: LakeContext, filter: { contract?: string; session?: string } = {}): Promise<VerifyReport> {
  return withLock(ctx.root, "verify", () => verifyHeld(ctx, filter));
}

async function verifyHeld(ctx: LakeContext, filter: { contract?: string; session?: string }): Promise<VerifyReport> {
  const all = storedTakes(ctx.root, filter);
  const report: VerifyReport = { takes: [], leftovers: [], ok: true };
  const sessions = new Set<string>();
  await withEngine(async (engine) => {
    for (const st of all) {
      sessions.add(path.dirname(st.dir));
      const problems: string[] = [];
      let tf: TakeFile | null = null;
      try {
        tf = readTake(st.dir);
      } catch (err) {
        problems.push(`take.json unreadable: ${err instanceof Error ? err.message : err}`);
      }
      if (tf) {
        if (!existsSync(checksPath(st.dir))) problems.push("checks.json is missing");
        for (const [stream, w] of Object.entries(tf.streams) as [StreamName, TakeFile["streams"]["prints"]][]) {
          const file = streamFile(st.dir, stream);
          if (!existsSync(file)) {
            problems.push(`${stream}: file missing`);
            continue;
          }
          const sha = await sha256File(file);
          if (sha !== w!.sha256) problems.push(`${stream}: sha256 ${sha} differs from take.json ${w!.sha256}`);
          try {
            await readStream(engine, file, stream, "v_stream");
            const fp = await fingerprint(engine, "v_stream", stream);
            if (fp.rows !== w!.rows || fp.fingerprint !== w!.fingerprint) {
              problems.push(`${stream}: holds ${fp.rows} rows (${fp.fingerprint}); take.json says ${w!.rows} (${w!.fingerprint})`);
            }
            const foot = await readFooter(engine, file);
            const want: Record<string, string> = {
              "nt8.stream": stream,
              "nt8.instrument": tf.instrument,
              "nt8.session": tf.session,
              "nt8.take": String(tf.take),
              "nt8.rows": String(w!.rows),
              "nt8.fingerprint": w!.fingerprint,
            };
            for (const [k, v] of Object.entries(want)) {
              if (foot[k] !== v) problems.push(`${stream}: footer ${k} is ${foot[k]}, expected ${v}`);
            }
          } catch (err) {
            problems.push(`${stream}: unreadable: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (tf.session !== st.label || tf.take !== st.take || tf.contract !== st.id.contract) {
          problems.push(`take.json says ${tf.contract} ${tf.session} take ${tf.take}, path says ${st.id.contract} ${st.label} take ${st.take}`);
        }
      }
      if (problems.length > 0) report.ok = false;
      report.takes.push({ contract: st.id.contract, session: st.label, take: st.take, problems });
    }
  });
  for (const s of sessions) report.leftovers.push(...listTempDirs(s));
  if (report.leftovers.length > 0) report.ok = false;
  return report;
}

export interface RecheckLine {
  contract: string;
  session: string;
  take: number;
  failing: string[];
  tierBefore: Tier | null;
  tierAfter: Tier | null;
}

export async function recheck(ctx: LakeContext, filter: { contract?: string; session?: string } = {}): Promise<RecheckLine[]> {
  return withLock(ctx.root, "recheck", () =>
    withEngine(async (engine) => {
      const out: RecheckLine[] = [];
      for (const st of storedTakes(ctx.root, filter)) {
        const sessionPath = path.dirname(st.dir);
        const before = dayState(sessionPath);
        const checks = await computeChecks(engine, st.dir, readTake(st.dir), checkContext(ctx, st.id));
        writeJsonAtomic(checksPath(st.dir), checks);
        const after = dayState(sessionPath);
        out.push({
          contract: st.id.contract,
          session: st.label,
          take: st.take,
          failing: checks.results.filter((r) => r.status !== "pass" && r.status !== "skipped").map((r) => r.id),
          tierBefore: before.selected === st.take ? before.tier : null,
          tierAfter: after.selected === st.take ? after.tier : null,
        });
      }
      return out;
    }),
  );
}

// ---------- hand labels (CLI only) ----------

function heldDay(ctx: LakeContext, contract: string, session: string): { dir: string; state: DayState } {
  assertLabel(session);
  const id = identifyContract(contract);
  const dir = sessionDir(ctx.root, id, session);
  const state = dayState(dir);
  if (state.takes.length === 0) throw new RefusedError(`${id.contract} ${session} is not in the lake`);
  return { dir, state };
}

function knownCheck(name: string, results: CheckResult[]): boolean {
  return results.some((r) => r.id === name || r.id.startsWith(`${name}.`));
}

export async function gold(
  ctx: LakeContext,
  contract: string,
  session: string,
  note: string,
  waive: string[] = [],
): Promise<DayState> {
  return withLock(ctx.root, "gold", async () => {
    const { dir, state } = heldDay(ctx, contract, session);
    if (!note.trim()) throw new RefusedError("a gold mark needs a note");
    if (state.selected === null || state.checks === null) throw new RefusedError("the selected take has no checks; run recheck");
    const unknown = waive.filter((w) => !knownCheck(w, state.results));
    if (unknown.length > 0) throw new RefusedError(`unknown checks: ${unknown.join(", ")}`);
    const unwaived = state.failing.filter((r) => !isWaived(r.id, waive));
    if (unwaived.length > 0) {
      throw new RefusedError(`failing and not waived: ${unwaived.map((r) => `${r.id} (${r.detail})`).join("; ")}`);
    }
    const day: DayFile = readDay(dir);
    if (day.gold) day.history = [...(day.history ?? []), { gold: day.gold, removedAt: new Date().toISOString() }];
    day.gold = { take: state.selected, at: new Date().toISOString(), note: note.trim(), waived: waive };
    writeDay(dir, day);
    return dayState(dir);
  });
}

export async function ungold(ctx: LakeContext, contract: string, session: string): Promise<DayState> {
  return withLock(ctx.root, "ungold", async () => {
    const { dir } = heldDay(ctx, contract, session);
    const day = readDay(dir);
    if (!day.gold) throw new RefusedError("this day has no gold mark");
    day.history = [...(day.history ?? []), { gold: day.gold, removedAt: new Date().toISOString() }];
    delete day.gold;
    writeDay(dir, day);
    return dayState(dir);
  });
}

export async function select(ctx: LakeContext, contract: string, session: string, take: number): Promise<DayState> {
  return withLock(ctx.root, "select", async () => {
    const { dir, state } = heldDay(ctx, contract, session);
    if (!state.takes.includes(take)) throw new RefusedError(`no take ${take}; this day holds ${state.takes.join(", ")}`);
    const day = readDay(dir);
    if (day.selection) day.history = [...(day.history ?? []), { selection: day.selection }];
    day.selection = { take, by: "hand", at: new Date().toISOString() };
    writeDay(dir, day);
    return dayState(dir);
  });
}

