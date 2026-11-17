import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeRequestError } from "../../src/bridge/connection.js";
import type { TicksResponseMessage } from "../../src/bridge/protocol.js";
import { PrefetchManager } from "../../src/core/cache/prefetch.js";
import { EMPTY_CALENDAR, type SessionCalendar } from "../../src/core/sessions/calendar.js";
import { sessionDayContaining } from "../../src/core/sessions/session-day.js";
import { wallClockToUnix } from "../../src/core/time.js";
import { initializeSchema } from "../../src/db/schema.js";
import {
  BUSY_RETRY_MS,
  BUSY_WAIT_MS,
  etDatesTouching,
  cutOf,
  etMidnight,
  MAX_FAILED_IN_A_ROW,
  STALE_FOLDER_MS,
  TICK_LANE,
  TickFetchManager,
  type LakeRun,
  type TickDaySnapshot,
  type TickFetchDeps,
} from "../../src/nt8-lake/fetch-job.js";
import { identify, listTakes, sessionDir, takeDir } from "../../src/nt8-lake/layout.js";
import { ingest, openSource, probe, type IngestReport, type ProbeReport } from "../../src/nt8-lake/ops.js";
import { RefusedError, type StreamName } from "../../src/nt8-lake/source.js";
import { CME, context, px, removeTmpRoots, tmpRoot } from "./helpers.js";

const et = (y: number, m: number, d: number, hh: number, mm = 0) => wallClockToUnix(y, m, d, hh, mm, 0, "America/New_York");
const NOW_MS = et(2026, 11, 2, 12) * 1000;
const NOW_TS = BigInt(NOW_MS) * 10_000n;
const ROLLS = [{ contractMonth: "2026-12-01", rolloverDate: "2026-09-11" }];

interface TickReq {
  instrument: string;
  stream: StreamName;
  day: string;
  job: string;
}

function rowsFor(contract: string, stream: StreamName, date: string): string[] {
  const offset = contract.includes("03-27") ? 40 : 0;
  const out: string[] = [];
  const end = Number(etMidnight(nextDay(date)) / 10_000_000n);
  let i = 0;
  for (let t = Number(etMidnight(date) / 10_000_000n); t < end; t += 600, i++) {
    if (sessionDayContaining(t, CME) === null) continue;
    const b = 120_000 + offset + ((t / 600) % 7);
    const ts = BigInt(t) * 10_000_000n;
    if (stream === "bid") out.push(`${ts};${px(b)};${5 + (i % 4)}`);
    else if (stream === "ask") out.push(`${ts};${px(b + 1)};${6 + (i % 3)}`);
    else out.push(`${ts + 5_000_000n};${px(i % 2 ? b + 1 : b)};${1 + (i % 3)};${px(b)};${px(b + 1)}`);
  }
  return out;
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

interface FakeOpts {
  /** The fake AddOn's <UserDataDir>/mcp-ticks.noindex. */
  writeTo: string;
  rollovers?: { contractMonth: string; rolloverDate: string }[] | null;
  fullName?: (contract: string) => string;
  fail?: (req: TickReq) => Error | null;
  reply?: (reply: TicksResponseMessage, req: TickReq) => TicksResponseMessage;
  afterWrite?: (file: string, req: TickReq) => void;
}

function fakeAddon(opts: FakeOpts) {
  const calls: { type: string; payload: Record<string, unknown> }[] = [];
  const request = async (type: string, payload: Record<string, unknown>): Promise<unknown> => {
    calls.push({ type, payload });
    if (type === "resolve_instrument") {
      return {
        v: 1,
        id: "r",
        type: "resolve_instrument_result",
        symbol: payload.symbol,
        contract: "MNQ 12-26",
        source: "rollover-table",
        attested: true,
        tradable: true,
        rollovers: opts.rollovers === undefined ? ROLLS : opts.rollovers,
      };
    }
    if (type !== "request_ticks") throw new Error(`unexpected ${type}`);
    const req = payload as unknown as TickReq;
    const err = opts.fail?.(req);
    if (err) throw err;
    const rows = rowsFor(req.instrument, req.stream, req.day);
    const dir = path.join(opts.writeTo, req.job);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${req.stream}.${req.day}.txt.gz`);
    if (rows.length > 0) writeFileSync(file, gzipSync(rows.map((r) => `${r}\n`).join("")));
    opts.afterWrite?.(file, req);
    const ts = rows.map((r) => r.split(";")[0]);
    const reply: TicksResponseMessage = {
      v: 1,
      id: "t",
      type: "ticks_response",
      instrument: opts.fullName ? opts.fullName(req.instrument) : req.instrument,
      stream: req.stream,
      day: req.day,
      file: rows.length > 0 ? `C:\\NT8\\mcp-ticks.noindex\\${req.job}\\${req.stream}.${req.day}.txt.gz` : null,
      rows: rows.length,
      sizeSum: String(rows.reduce((n, r) => n + Number(r.split(";")[2]), 0)),
      firstTs: ts[0] ?? null,
      lastTs: ts[ts.length - 1] ?? null,
      dayFromTs: String(etMidnight(req.day)),
      dayToTs: String(etMidnight(nextDay(req.day))),
      loadedRows: rows.length,
      loadedFirstTs: ts[0] ?? null,
      loadedLastTs: ts[ts.length - 1] ?? null,
      tickSize: "0.25",
      mergePolicy: "DoNotMerge",
      priceBasis: "as_traded",
      lookup: "provider",
      dataSource: "Rithmic",
      timeZone: "Eastern Standard Time",
      fetchedAt: String(NOW_TS),
      elapsedMs: 5,
      memoryBeforeMb: 100,
      memoryAfterMb: 120,
      guestFreeBeforeMb: 6000,
      guestFreeAfterMb: 5200,
      addonVersion: "2",
    };
    return opts.reply ? opts.reply(reply, req) : reply;
  };
  const ticks = () =>
    calls.filter((c) => c.type === "request_ticks").map((c) => `${c.payload.instrument} ${c.payload.stream} ${c.payload.day}`);
  return { request, calls, ticks };
}

function inProcess<T>(run: () => Promise<T>): Promise<LakeRun<T>> {
  return run().then(
    (report) => ({ report }),
    (err) => (err instanceof RefusedError ? { refused: err.message } : { failed: String(err) }),
  );
}

function harness(fake: Partial<FakeOpts> = {}, deps: Partial<TickFetchDeps> = {}) {
  const root = deps.lakeRoot ? deps.lakeRoot() : tmpRoot();
  const drop = path.join(tmpRoot(), "mcp-ticks.noindex");
  const addon = fakeAddon({ writeTo: drop, ...fake });
  const lines: string[] = [];
  const manager = new TickFetchManager({
    request: addon.request,
    fetch: addon.request,
    isConnected: () => true,
    caps: () => ["place_order", "request_ticks.v2"],
    dropPath: () => drop,
    lakeRoot: () => root,
    calendarFor: () => EMPTY_CALENDAR,
    cacheFront: () => null,
    runIngest: (folder) => inProcess<IngestReport>(async () => ingest(context(root), await openSource("addon", folder))),
    runProbe: (folder) => inProcess<ProbeReport>(async () => probe(context(root), await openSource("addon", folder))),
    freeBytes: () => 1e12,
    nowMs: () => NOW_MS,
    log: (l) => lines.push(l),
    ...deps,
  });
  const run = async (args: { start: string; end: string; contract?: string; refetch?: boolean }) => {
    const res = await manager.start({ symbol: "MNQ", ...args });
    if ("error" in res) throw new Error(res.error);
    await manager.whenSettled(res.job.jobId);
    const done = manager.status(res.job.jobId);
    if ("error" in done) throw new Error(done.error);
    return { plan: res.job, job: done.job, day: (s: string) => done.job.days.find((d) => d.session === s)! };
  };
  const takes = (contract: string, session: string) => listTakes(sessionDir(root, identify(contract), session));
  return { root, drop, addon, manager, run, takes, lines };
}

const states = (days: TickDaySnapshot[]) => days.map((d) => [d.session, d.state]);
const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;

afterEach(removeTmpRoots);

describe("plan geometry", () => {
  it("a Monday cut touches Friday through Monday; a weekday cut touches two dates", () => {
    expect(etDatesTouching(cutOf("2026-10-26", CME))).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(etDatesTouching(cutOf("2026-10-28", CME))).toEqual(["2026-10-27", "2026-10-28"]);
  });
});

describe("a tick fetch job", () => {
  it("stores days one and three when day two's bid request errors, fetching the shared date once", async () => {
    let failed = false;
    const h = harness({
      fail: (r) => {
        if (failed || r.stream !== "bid" || r.day !== "2026-10-28") return null;
        failed = true;
        return new BridgeRequestError("BarsRequest failed: provider timeout", "remote-error", true, "bars_request_failed");
      },
    });
    const { job, day } = await h.run({ start: "2026-10-27", end: "2026-10-29" });
    expect(states(job.days)).toEqual([
      ["2026-10-27", "stored"],
      ["2026-10-28", "failed"],
      ["2026-10-29", "stored"],
    ]);
    expect(day("2026-10-28").reason).toBe("bars_request_failed: BarsRequest failed: provider timeout");
    expect(job.state).toBe("completed_with_failures");
    const ticks = h.addon.ticks();
    for (const s of ["prints", "bid", "ask"]) expect(count(ticks, `MNQ 12-26 ${s} 2026-10-27`)).toBe(1);
    expect(count(ticks, "MNQ 12-26 prints 2026-10-28")).toBe(1);
    expect(count(ticks, "MNQ 12-26 bid 2026-10-28")).toBe(2);
    expect(h.takes("MNQ 12-26", "2026-10-27")).toEqual([1]);
    expect(h.takes("MNQ 12-26", "2026-10-28")).toEqual([]);
    expect(h.takes("MNQ 12-26", "2026-10-29")).toEqual([1]);
    expect(day("2026-10-27")).toMatchObject({ take: 1, tier: "RAW", rows: { prints: expect.any(Number) } });
    expect(readdirSync(h.drop)).toEqual([]);
  });

  it("fetches Friday, Saturday, Sunday and Monday for a Monday, which is whole by manifest", async () => {
    const h = harness();
    const { day } = await h.run({ start: "2026-10-26", end: "2026-10-26" });
    expect(day("2026-10-26").state).toBe("stored");
    expect(new Set(h.addon.ticks().map((t) => t.split(" ").pop()))).toEqual(
      new Set(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]),
    );
    expect(h.addon.ticks()).toHaveLength(12);
    const take = JSON.parse(readFileSync(path.join(takeDir(h.root, identify("MNQ 12-26"), "2026-10-26", 1), "take.json"), "utf-8"));
    expect(take.wholeBy).toBe("manifest");
    expect(take.source.kind).toBe("addon");
    expect(take.source.manifest).toMatchObject({
      instrument: "MNQ 12-26",
      tickSize: "0.25",
      window: { from: String(etMidnight("2026-10-23")), to: String(etMidnight("2026-10-27")) },
      fetchedAt: String(NOW_TS),
      priceBasis: "as_traded",
      origin: "provider",
      provider: "Rithmic",
    });
  });

  it("does not request a day whose close has not passed, nor a held day; refetch reports already_held", async () => {
    const h = harness();
    await h.run({ start: "2026-10-27", end: "2026-10-27" });
    const before = h.addon.ticks().length;
    const early = harness({}, { lakeRoot: () => h.root, nowMs: () => et(2026, 10, 28, 16) * 1000 });
    const { plan, job } = await early.run({ start: "2026-10-27", end: "2026-10-28" });
    expect(states(plan.days)).toEqual([
      ["2026-10-27", "held"],
      ["2026-10-28", "not_closed"],
    ]);
    expect(job.state).toBe("completed");
    expect(early.addon.ticks()).toEqual([]);
    expect(h.addon.ticks()).toHaveLength(before);

    const again = harness({}, { lakeRoot: () => h.root });
    const { day } = await again.run({ start: "2026-10-27", end: "2026-10-27", refetch: true });
    expect(day("2026-10-27")).toMatchObject({ state: "already_held", take: 1 });
  });

  it("stores nothing when a part was fetched before the session closed", async () => {
    const h = harness({
      reply: (r, req) => (req.stream === "prints" && req.day === "2026-10-28" ? { ...r, fetchedAt: String(BigInt(et(2026, 10, 28, 16)) * 10_000_000n) } : r),
    });
    const { day } = await h.run({ start: "2026-10-28", end: "2026-10-28" });
    expect(day("2026-10-28").state).toBe("partial");
    expect(day("2026-10-28").reason).toMatch(/before the session closed/);
    expect(existsSync(path.join(h.root, "ticks"))).toBe(false);
  });

  it("notes a day where the cache's front contract differs", async () => {
    const h = harness({}, { cacheFront: () => "MNQ 09-26" });
    const { plan } = await h.run({ start: "2026-10-28", end: "2026-10-28" });
    expect(plan.days[0].note).toBe("the cache's front contract for this day is MNQ 09-26");
  });

  it("skips a date the calendar calls closed", async () => {
    const calendar: SessionCalendar = new Map([["2026-10-28", { date: "2026-10-28", kind: "closed", source: "manual", description: "test holiday" }]]);
    const h = harness({}, { calendarFor: () => calendar });
    const { plan } = await h.run({ start: "2026-10-28", end: "2026-10-28" });
    expect(plan.days[0]).toMatchObject({ state: "closed", reason: "calendar: test holiday" });
    expect(h.addon.ticks()).toEqual([]);
  });
});

describe("refusals store nothing", () => {
  const day = "2026-10-28";
  const noLake = (root: string) => expect(existsSync(path.join(root, "ticks"))).toBe(false);

  it("a part from the Simulated Data Feed", async () => {
    const h = harness({ reply: (r, req) => (req.stream === "ask" ? { ...r, dataSource: "Simulated Data Feed" } : r) });
    const { day: d } = await h.run({ start: day, end: day });
    expect(d(day)).toMatchObject({ state: "refused", reason: expect.stringMatching(/Simulated Data Feed: ask 2026-10-27, ask 2026-10-28/) });
    expect(d(day).folder).toBeDefined();
    expect(existsSync(d(day).folder!)).toBe(true);
    noLake(h.root);
  });

  it("a part served with no data feed connected", async () => {
    const h = harness({ reply: (r, req) => (req.day === day ? { ...r, dataSource: "" } : r) });
    const { day: d } = await h.run({ start: day, end: day });
    expect(d(day)).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/no data feed was connected in NT8: prints 2026-10-28, bid 2026-10-28, ask 2026-10-28/),
    });
    noLake(h.root);
  });

  it("day bounds that are not Eastern midnights", async () => {
    const hour = 3600n * 10_000_000n;
    const h = harness({
      reply: (r) => ({ ...r, timeZone: "Central Standard Time", dayFromTs: String(BigInt(r.dayFromTs) + hour), dayToTs: String(BigInt(r.dayToTs) + hour) }),
    });
    const { day: d } = await h.run({ start: day, end: day });
    expect(d(day)).toMatchObject({ state: "refused", reason: expect.stringMatching(/Central Standard Time\) is not US Eastern/) });
    noLake(h.root);
  });

  it("a part file changed after its response", async () => {
    const h = harness({
      afterWrite: (file, req) => {
        if (req.stream !== "prints" || req.day !== day) return;
        const text = gunzipSync(readFileSync(file)).toString();
        writeFileSync(file, gzipSync(`${text}${etMidnight(day) + 1n};30000;1;30000;30000.25\n`));
      },
    });
    const { day: d } = await h.run({ start: day, end: day });
    expect(d(day)).toMatchObject({ state: "refused", reason: expect.stringMatching(/prints differs from the attested manifest: rows/) });
    expect(existsSync(d(day).manifest!)).toBe(true);
    expect(readdirSync(d(day).folder!).sort()).toEqual([
      "ask.2026-10-27.txt.gz",
      "ask.2026-10-28.txt.gz",
      "bid.2026-10-27.txt.gz",
      "bid.2026-10-28.txt.gz",
      "manifest.2026-10-28.json",
      "prints.2026-10-27.txt.gz",
      "prints.2026-10-28.txt.gz",
    ]);
    noLake(h.root);
  });

  it("a drop folder the hub cannot see", async () => {
    const elsewhere = tmpRoot();
    const h = harness({ writeTo: elsewhere });
    const { day: d } = await h.run({ start: day, end: day });
    expect(d(day)).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/the AddOn wrote C:\\NT8\\mcp-ticks\.noindex\\.*prints\.2026-10-27\.txt\.gz, but the hub finds no .*NT_TICK_DROP_PATH/),
    });
    noLake(h.root);
  });

  it("an AddOn without the cap, or with the cap of an older drop-file format", async () => {
    for (const caps of [["place_order", "set_indicator_params"], ["place_order", "request_ticks"]]) {
      const h = harness({}, { caps: () => caps });
      const res = await h.manager.start({ symbol: "MNQ", start: day, end: day });
      expect(res).toEqual({ error: expect.stringMatching(/does not support request_ticks\.v2 — recompile/) });
      expect(h.addon.calls).toEqual([]);
      noLake(h.root);
    }
  });

  it("an AddOn whose reply names another file format", async () => {
    const h = harness({ reply: (r) => ({ ...r, addonVersion: "1" }) });
    const { day: d } = await h.run({ start: day, end: day });
    expect(d(day)).toMatchObject({ state: "refused", reason: expect.stringMatching(/format 1; this hub reads format 2: recompile/) });
    expect(h.addon.ticks()).toHaveLength(1);
    noLake(h.root);
  });

  it("no drop path, or no connection", async () => {
    expect(await harness({}, { dropPath: () => undefined }).manager.start({ symbol: "MNQ", start: day, end: day })).toEqual({
      error: expect.stringMatching(/NT_TICK_DROP_PATH is not set/),
    });
    expect(await harness({}, { isConnected: () => false }).manager.start({ symbol: "MNQ", start: day, end: day })).toEqual({
      error: expect.stringMatching(/not connected/),
    });
  });
});

describe("the executor", () => {
  it("runs a candle fill issued mid-job between two stream requests", async () => {
    const h = harness();
    const order: string[] = [];
    let release!: () => void;
    const db = new Database(":memory:");
    initializeSchema(db);
    const pm = new PrefetchManager({
      db,
      isConnected: () => true,
      request: async (type, payload) => {
        order.push(type === "request_ticks" ? `${payload.stream} ${payload.day}` : type);
        if (order.length === 1) await new Promise<void>((r) => (release = r));
        return type === "request_ticks" ? h.addon.request(type, payload) : {};
      },
    });
    const manager = new TickFetchManager({
      request: h.addon.request,
      fetch: (type, payload, ms) => pm.backgroundRequest(TICK_LANE, type, payload, ms),
      isConnected: () => true,
      caps: () => ["request_ticks.v2"],
      dropPath: () => h.drop,
      lakeRoot: () => h.root,
      calendarFor: () => EMPTY_CALENDAR,
      cacheFront: () => null,
      runIngest: (folder) => inProcess<IngestReport>(async () => ingest(context(h.root), await openSource("addon", folder))),
      runProbe: async () => ({ failed: "unused" }),
      freeBytes: () => 1e12,
      nowMs: () => NOW_MS,
      log: () => {},
    });
    const res = await manager.start({ symbol: "MNQ", start: "2026-10-28", end: "2026-10-28" });
    if ("error" in res) throw new Error(res.error);
    await vi.waitFor(() => expect(order).toHaveLength(1));
    const fill = pm.scheduledRequest("request_candles", { symbol: "MNQ" });
    release();
    await fill;
    await manager.whenSettled(res.job.jobId);
    expect(order.slice(0, 3)).toEqual(["prints 2026-10-27", "request_candles", "bid 2026-10-27"]);
    expect(h.takes("MNQ 12-26", "2026-10-28")).toEqual([1]);
  });
});

describe("which contract", () => {
  const rolls = [
    { contractMonth: "2026-12-01", rolloverDate: "2026-09-11" },
    { contractMonth: "2027-03-01", rolloverDate: "2026-10-28" },
  ];

  it("fetches the old contract before the roll date and the new one from it, into two lake paths", async () => {
    const h = harness({ rollovers: rolls });
    const { plan, job } = await h.run({ start: "2026-10-27", end: "2026-10-28" });
    expect(plan.days.map((d) => [d.session, d.contract, d.contractFrom])).toEqual([
      ["2026-10-27", "MNQ 12-26", "rollover-table"],
      ["2026-10-28", "MNQ 03-27", "rollover-table"],
    ]);
    expect(states(job.days)).toEqual([
      ["2026-10-27", "stored"],
      ["2026-10-28", "stored"],
    ]);
    expect(count(h.addon.ticks(), "MNQ 12-26 prints 2026-10-27")).toBe(1);
    expect(count(h.addon.ticks(), "MNQ 03-27 prints 2026-10-27")).toBe(1);
    expect(h.takes("MNQ 12-26", "2026-10-27")).toEqual([1]);
    expect(h.takes("MNQ 03-27", "2026-10-28")).toEqual([1]);
  });

  it("refuses a day no rollover window covers, and an unreadable table", async () => {
    const h = harness({ rollovers: [{ contractMonth: "2027-03-01", rolloverDate: "2026-10-28" }] });
    const { job, day } = await h.run({ start: "2026-10-27", end: "2026-10-28" });
    expect(day("2026-10-27")).toMatchObject({
      state: "unattested",
      contract: null,
      reason: "no rollover window covers 2026-10-27 (NT8's table starts 2026-10-28); pass contract to name it",
    });
    expect(day("2026-10-28").state).toBe("stored");
    expect(job.state).toBe("completed_with_failures");
    expect(h.addon.ticks().every((t) => t.startsWith("MNQ 03-27"))).toBe(true);

    const none = harness({ rollovers: null });
    expect(await none.manager.start({ symbol: "MNQ", start: "2026-10-28", end: "2026-10-28" })).toEqual({
      error: expect.stringMatching(/NT8 sent no rollover table for MNQ/),
    });
  });

  it("lets contract override the table, and stores MNQ DEC26 and MNQ 12-26 in one path", async () => {
    const h = harness({ rollovers: rolls, fullName: (c) => c.replace("12-26", "DEC26") });
    const { plan, job } = await h.run({ start: "2026-10-27", end: "2026-10-28", contract: "MNQ DEC26" });
    expect(plan.days.map((d) => [d.contract, d.contractFrom])).toEqual([
      ["MNQ 12-26", "override"],
      ["MNQ 12-26", "override"],
    ]);
    expect(h.addon.calls.some((c) => c.type === "resolve_instrument")).toBe(false);
    expect(states(job.days)).toEqual([
      ["2026-10-27", "stored"],
      ["2026-10-28", "stored"],
    ]);
    expect(readdirSync(path.join(h.root, "ticks", "symbol=MNQ"))).toEqual(["contract=MNQ_12-26"]);
    expect(await h.manager.start({ symbol: "MNQ", start: "2026-10-28", end: "2026-10-28", contract: "NQ 12-26" })).toEqual({
      error: "contract NQ 12-26 is not a MNQ contract",
    });
  });
});

describe("the drop folder", () => {
  it("removes job folders untouched for 24 h, and only the files a job writes", async () => {
    const h = harness();
    const stale = path.join(h.drop, "tk-abc-1-MNQ-12-26");
    const fresh = path.join(h.drop, "tk-abc-2-MNQ-12-26");
    const foreign = path.join(h.drop, "notes");
    for (const dir of [stale, fresh, foreign]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "prints.2026-10-01.txt.gz"), "x\n");
    }
    writeFileSync(path.join(stale, "mine.txt"), "keep\n");
    const old = (NOW_MS - STALE_FOLDER_MS - 60_000) / 1000;
    utimesSync(stale, old, old);
    utimesSync(foreign, old, old);
    await h.run({ start: "2026-10-28", end: "2026-10-28" });
    expect(readdirSync(stale)).toEqual(["mine.txt"]);
    expect(readdirSync(fresh)).toEqual(["prints.2026-10-01.txt.gz"]);
    expect(readdirSync(foreign)).toEqual(["prints.2026-10-01.txt.gz"]);
  });

  it("refuses a day when the drop path has less than 1 GB free", async () => {
    const h = harness({}, { freeBytes: () => 0.5 * 1024 ** 3 });
    const { day } = await h.run({ start: "2026-10-28", end: "2026-10-28" });
    expect(day("2026-10-28")).toMatchObject({ state: "failed", reason: expect.stringMatching(/0\.5 GB free .* needs 1\.0 GB/) });
    expect(h.addon.ticks()).toEqual([]);
  });

  it("holds only gzip parts of the dates the day in progress needs", async () => {
    let h!: ReturnType<typeof harness>;
    const onDisk = new Map<string, Set<string>>();
    const look = () => {
      const day = h.manager.status().jobs[0].days.find((d) => d.state === "fetching" || d.state === "ingesting")!;
      for (const folder of readdirSync(h.drop)) {
        for (const f of readdirSync(path.join(h.drop, folder)).filter((n) => !n.startsWith("manifest"))) {
          expect(f).toMatch(/\.txt\.gz$/);
          expect(readFileSync(path.join(h.drop, folder, f)).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
          const date = f.split(".")[1];
          expect(day.dates).toContain(date);
          onDisk.set(day.session, (onDisk.get(day.session) ?? new Set()).add(date));
        }
      }
    };
    h = harness(
      { afterWrite: look },
      { runIngest: async (folder) => (look(), inProcess<IngestReport>(async () => ingest(context(h.root), await openSource("addon", folder)))) },
    );
    const { job } = await h.run({ start: "2026-10-22", end: "2026-10-27" });
    expect(states(job.days)).toEqual([
      ["2026-10-22", "stored"],
      ["2026-10-23", "stored"],
      ["2026-10-26", "stored"],
      ["2026-10-27", "stored"],
    ]);
    expect([...onDisk.get("2026-10-26")!].sort()).toEqual(["2026-10-23", "2026-10-25", "2026-10-26"]);
    expect([...onDisk.get("2026-10-27")!].sort()).toEqual(["2026-10-26", "2026-10-27"]);
  });
});

describe("an AddOn still busy with an earlier load", () => {
  const busy = () =>
    new BridgeRequestError(
      "request_ticks refused: NT8 is still loading request old-1 (MNQ 12-26 bid 2026-10-27), started 3 min ago; one tick load at a time",
      "remote-error",
      true,
      "busy",
    );

  it("is waited on, then the same request goes again; the hub says what the job waits on", async () => {
    let left = 2;
    const waits: number[] = [];
    const seen: (string | null)[] = [];
    const h: ReturnType<typeof harness> = harness(
      { fail: () => (left-- > 0 ? busy() : null) },
      {
        sleep: async (ms) => {
          waits.push(ms);
          seen.push(h.manager.activity());
        },
      },
    );
    const { job, day } = await h.run({ start: "2026-10-28", end: "2026-10-28" });
    expect(day("2026-10-28").state).toBe("stored");
    expect(waits).toEqual([BUSY_RETRY_MS, BUSY_RETRY_MS]);
    expect(seen[0]).toMatch(
      /^tick job tk-\S+ is running \(MNQ, 0 of 1 session-days finished, fetching prints 2026-10-27, waiting: request_ticks refused: NT8 is still loading request old-1/,
    );
    expect(job.requests).toBe(6 + 2);
    expect(h.manager.activity()).toBeNull();
  });

  it(`fails the day after ${BUSY_WAIT_MS / 60_000} min, and ${MAX_FAILED_IN_A_ROW} such days stop the job`, async () => {
    const waits: number[] = [];
    const h = harness({ fail: busy }, { sleep: async (ms) => void waits.push(ms) });
    const { job, day } = await h.run({ start: "2026-10-27", end: "2026-10-30" });
    expect(job.state).toBe("stopped");
    expect(states(job.days)).toEqual([
      ["2026-10-27", "failed"],
      ["2026-10-28", "failed"],
      ["2026-10-29", "failed"],
      ["2026-10-30", "cancelled"],
    ]);
    expect(day("2026-10-27").reason).toMatch(/^busy: request_ticks refused: NT8 is still loading .*; still busy after 15 min$/);
    expect(waits).toHaveLength(MAX_FAILED_IN_A_ROW * (BUSY_WAIT_MS / BUSY_RETRY_MS));
  });

  it("stops waiting when the job is cancelled", async () => {
    const h: ReturnType<typeof harness> = harness(
      { fail: busy },
      { sleep: async () => void h.manager.cancel(h.manager.status().jobs[0].jobId) },
    );
    const { job, day } = await h.run({ start: "2026-10-28", end: "2026-10-28" });
    expect(job.state).toBe("cancelled");
    expect(day("2026-10-28").state).toBe("cancelled");
    expect(h.addon.ticks()).toHaveLength(1);
  });

  it("is not waited on by a probe", async () => {
    const waits: number[] = [];
    const h = harness({ fail: busy }, { sleep: async (ms) => void waits.push(ms) });
    expect(await h.manager.probe({ contract: "MNQ 12-26", days: ["2026-10-28"] })).toMatchObject({
      error: expect.stringMatching(/^prints 2026-10-28: busy: request_ticks refused/),
    });
    expect(waits).toEqual([]);
  });
});

describe("cancel and the probe", () => {
  it("cancel takes effect before the next stream request", async () => {
    let release!: () => void;
    const h = harness();
    const manager = new TickFetchManager({
      request: h.addon.request,
      fetch: async (type, payload) => {
        if (h.addon.ticks().length === 0) await new Promise<void>((r) => (release = r));
        return h.addon.request(type, payload);
      },
      isConnected: () => true,
      caps: () => ["request_ticks.v2"],
      dropPath: () => h.drop,
      lakeRoot: () => h.root,
      calendarFor: () => EMPTY_CALENDAR,
      cacheFront: () => null,
      runIngest: async () => ({ failed: "unused" }),
      runProbe: async () => ({ failed: "unused" }),
      freeBytes: () => 1e12,
      nowMs: () => NOW_MS,
      log: () => {},
    });
    const res = await manager.start({ symbol: "MNQ", start: "2026-10-27", end: "2026-10-28", owner: "a" });
    if ("error" in res) throw new Error(res.error);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(manager.cancel(res.job.jobId, { by: "b" })).toEqual({ error: expect.stringMatching(/another conversation/) });
    expect(manager.cancel(res.job.jobId, { by: "a" })).toMatchObject({ job: { state: "cancelled" } });
    release();
    await manager.whenSettled(res.job.jobId);
    const done = manager.status(res.job.jobId);
    if ("error" in done) throw new Error(done.error);
    expect(states(done.job.days)).toEqual([
      ["2026-10-27", "cancelled"],
      ["2026-10-28", "cancelled"],
    ]);
    expect(h.addon.ticks()).toEqual(["MNQ 12-26 prints 2026-10-26"]);
    expect(readdirSync(h.drop)).toEqual([]);
  });

  it("probes whole days, reporting each stream and every response, and stores nothing", async () => {
    const h = harness();
    const res = await h.manager.probe({ contract: "MNQ DEC26", days: ["2026-10-28"], toOffsetDays: 1 });
    if ("error" in res) throw new Error(res.error);
    expect(res.probe.contract).toBe("MNQ 12-26");
    expect(res.probe.knobs).toEqual({ lookup: "provider", tradingHours: "Default 24 x 7", toOffsetDays: 1 });
    expect(h.addon.calls.map((c) => c.payload.toOffsetDays)).toEqual([1, 1, 1]);
    for (const s of ["prints", "bid", "ask"] as const) {
      expect(res.probe.streams[s]).toMatchObject({ rows: rowsFor("MNQ 12-26", s, "2026-10-28").length, fingerprint: expect.stringMatching(/^\d+$/) });
      expect(res.probe.streams[s]!.bytes).toBeGreaterThan(0);
    }
    expect(res.probe.requests.map((r) => [r.stream, r.day, r.elapsedMs])).toEqual([
      ["prints", "2026-10-28", 5],
      ["bid", "2026-10-28", 5],
      ["ask", "2026-10-28", 5],
    ]);
    expect(res.probe.warnings).toEqual([]);
    expect(existsSync(res.probe.folder)).toBe(true);
    expect(existsSync(path.join(h.root, "ticks"))).toBe(false);
    expect(await h.manager.probe({ contract: "MNQ 12-26", days: ["2026-10-32"] })).toEqual({ error: 'day "2026-10-32" is not a YYYY-MM-DD date' });
    expect(await h.manager.probe({ contract: "MNQ 12-26", days: ["2026-10-26", "2026-10-27", "2026-10-28"] })).toEqual({
      error: expect.stringMatching(/^probe 1 to 2 days, not 3: the probe holds every day it fetches in memory at once$/),
    });
  });
});

describe("a broken setup stops the job", () => {
  const lowMemory = () =>
    new BridgeRequestError(
      "request_ticks refused: Windows has 3100 MB of physical memory available; a tick fetch needs 4096 MB",
      "remote-error",
      true,
      "low_memory",
    );

  it(`after ${MAX_FAILED_IN_A_ROW} days in a row end refused or failed, and fetches nothing more`, async () => {
    const h = harness({ fail: lowMemory });
    const { job } = await h.run({ start: "2026-10-26", end: "2026-10-30" });
    expect(job.state).toBe("stopped");
    expect(states(job.days)).toEqual([
      ["2026-10-26", "failed"],
      ["2026-10-27", "failed"],
      ["2026-10-28", "failed"],
      ["2026-10-29", "cancelled"],
      ["2026-10-30", "cancelled"],
    ]);
    expect(job.days[0].reason).toMatch(/^low_memory: request_ticks refused: Windows has 3100 MB/);
    expect(job.days[3].reason).toBe("not fetched: the job stopped after 3 days in a row ended refused or failed");
    expect(h.addon.ticks()).toHaveLength(3);
    expect(existsSync(h.drop)).toBe(false);
  });

  it("but not when a stored day breaks the run", async () => {
    let h!: ReturnType<typeof harness>;
    const failing = new Set(["2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30"]);
    const inProgress = () => h.manager.status().jobs[0].days.find((d) => d.state === "fetching")?.session ?? "";
    h = harness({ fail: () => (failing.has(inProgress()) ? lowMemory() : null) });
    const { job } = await h.run({ start: "2026-10-26", end: "2026-10-30" });
    expect(job.state).toBe("completed_with_failures");
    expect(states(job.days)).toEqual([
      ["2026-10-26", "failed"],
      ["2026-10-27", "failed"],
      ["2026-10-28", "stored"],
      ["2026-10-29", "failed"],
      ["2026-10-30", "failed"],
    ]);
  });
});
