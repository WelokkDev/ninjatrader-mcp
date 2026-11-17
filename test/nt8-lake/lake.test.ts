import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, uptime } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionCalendar } from "../../src/core/sessions/calendar.js";
import { openEngine } from "../../src/nt8-lake/engine.js";
import { contractDir, identify, LOCK_FILE, sessionDir, streamFile, takeDir } from "../../src/nt8-lake/layout.js";
import { dayState } from "../../src/nt8-lake/labels.js";
import { gold, ingest, recheck, select, show, status, ungold, verify, withLock } from "../../src/nt8-lake/ops.js";
import { fingerprint, readFooter, readStream } from "../../src/nt8-lake/reader.js";
import { cutsSpanning, proveWhole } from "../../src/nt8-lake/session-cut.js";
import { rowsSource, unattestedManifest, type FetchManifest, type Row } from "../../src/nt8-lake/source.js";
import { barsOf, CME, context, cutOf, px, removeTmpRoots, syntheticDay, tmpRoot, ts, type Streams } from "./helpers.js";
import { wallClockToUnix } from "../../src/core/time.js";

const MNQ = "MNQ 12-26";
const ID = identify(MNQ);
const et = (y: number, m: number, d: number, hh: number, mm = 0, ss = 0) => wallClockToUnix(y, m, d, hh, mm, ss, "America/New_York");

function source(streams: Partial<Streams>, manifest?: FetchManifest, instrument = MNQ) {
  return rowsSource({ instrument, streams, manifest });
}

async function readRows(file: string, stream: "prints" | "bid" | "ask") {
  const engine = await openEngine();
  try {
    await readStream(engine, file, stream, "r");
    return (await engine.con.runAndReadAll("SELECT rn, ts, px, size, bid, ask FROM r ORDER BY rn")).getRowObjectsJson();
  } finally {
    engine.close();
  }
}

const root = tmpRoot;
afterEach(removeTmpRoots);

describe("session-day cut", () => {
  it("cuts at the regular 17:00 ET close, Friday to Monday across a weekend", () => {
    const fri = et(2026, 10, 23, 17);
    const mon = et(2026, 10, 26, 17);
    const cuts = cutsSpanning(ts(fri - 1), ts(mon - 1), CME);
    expect(cuts.map((c) => c.label)).toEqual(["2026-10-23", "2026-10-26"]);
    expect(cuts[1]).toEqual({ label: "2026-10-26", from: fri, to: mon });
  });

  it("holds both clock changes in whole hours of UTC", () => {
    const spring = cutsSpanning(ts(et(2026, 3, 6, 12)), ts(et(2026, 3, 9, 12)), CME).find((c) => c.label === "2026-03-09")!;
    expect(spring.from).toBe(Date.UTC(2026, 2, 6, 22) / 1000);
    expect(spring.to).toBe(Date.UTC(2026, 2, 9, 21) / 1000);
    const fall = cutsSpanning(ts(et(2026, 10, 30, 12)), ts(et(2026, 11, 2, 12)), CME).find((c) => c.label === "2026-11-02")!;
    expect(fall.from).toBe(Date.UTC(2026, 9, 30, 21) / 1000);
    expect(fall.to).toBe(Date.UTC(2026, 10, 2, 22) / 1000);
  });

  it("puts a row exactly on the close into the next session-day", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    const close = cutOf("2026-10-28").to;
    day.prints.push({ ts: ts(close) - 1n, px: px(120_000), size: 1, bid: px(120_000), ask: px(120_001) });
    day.prints.push({ ts: ts(close), px: px(120_000), size: 1, bid: px(120_000), ask: px(120_001) });
    day.prints.sort((a, b) => (a.ts! < b.ts! ? -1 : a.ts! > b.ts! ? 1 : 0));
    const rep = await ingest(context(r), source(day));
    expect(rep.days.map((d) => [d.session, d.status])).toEqual([
      ["2026-10-27", "partial"],
      ["2026-10-28", "stored"],
      ["2026-10-29", "partial"],
    ]);
    const rows = await readRows(streamFile(takeDir(r, ID, "2026-10-28", 1), "prints"), "prints");
    expect(rows[rows.length - 1].ts).toBe(String(ts(close) - 1n));
    expect(rep.days[2].rows.prints).toBe(2);
  });

  it("rides weekend rows at the front of Monday", async () => {
    const r = root();
    const mon = syntheticDay("2026-10-26");
    const sat = et(2026, 10, 24, 12);
    mon.prints.splice(1, 0, { ts: ts(sat), px: px(120_000), size: 1, bid: px(120_000), ask: px(120_001) });
    const rep = await ingest(context(r), source(mon));
    expect(rep.days.find((d) => d.session === "2026-10-26")?.status).toBe("stored");
    const rows = await readRows(streamFile(takeDir(r, ID, "2026-10-26", 1), "prints"), "prints");
    expect(rows[0].ts).toBe(String(ts(sat)));
  });
});

describe("wholeness", () => {
  it("proves a Friday whole from an attested window with no later row", async () => {
    const r = root();
    const fri = syntheticDay("2026-10-30");
    const cut = cutOf("2026-10-30");
    const streams = { prints: fri.prints.slice(0, -1), bid: fri.bid.slice(0, -1), ask: fri.ask.slice(0, -1) };
    const manifest: FetchManifest = {
      ...unattestedManifest(["prints", "bid", "ask"]),
      tickSize: "0.25",
      window: { from: String(ts(cut.from)), to: String(ts(cut.to)) },
      fetchedAt: String(ts(cut.to + 3600)),
    };
    expect(proveWhole(cut, unattestedManifest(["prints"]), { prints: { minTs: ts(cut.from - 5), maxTs: ts(cut.to - 1) } }).whole).toBe(false);
    const rep = await ingest(context(r), source(streams, manifest));
    const day = rep.days.find((d) => d.session === "2026-10-30")!;
    expect(day.status).toBe("stored");
    const take = JSON.parse(readFileSync(path.join(takeDir(r, ID, "2026-10-30", 1), "take.json"), "utf-8"));
    expect(take.wholeBy).toBe("manifest");
    expect(take.tickSizeFrom).toBe("manifest");
  });

  it("does not store a day fetched before its close", async () => {
    const r = root();
    const cut = cutOf("2026-10-30");
    const manifest: FetchManifest = {
      ...unattestedManifest(["prints", "bid", "ask"]),
      window: { from: String(ts(cut.from)), to: String(ts(cut.to)) },
      fetchedAt: String(ts(cut.to - 60)),
    };
    const rep = await ingest(context(r), source(syntheticDay("2026-10-30"), manifest));
    expect(rep.days.find((d) => d.session === "2026-10-30")?.status).toBe("partial");
    expect(existsSync(path.join(r, "ticks"))).toBe(false);
  });
});

describe("one input, several session-days", () => {
  it("reports every day and stores each whole one with its rows as given", async () => {
    const r = root();
    const tue = syntheticDay("2026-10-27");
    const wed = syntheticDay("2026-10-28");
    const byTs = (a: Row, b: Row) => (a.ts! < b.ts! ? -1 : a.ts! > b.ts! ? 1 : 0);
    const both: Streams = {
      prints: [...tue.prints, ...wed.prints].sort(byTs),
      bid: [...tue.bid, ...wed.bid].sort(byTs),
      ask: [...tue.ask, ...wed.ask].sort(byTs),
    };
    const inCut = (rows: Row[], label: string) => {
      const { from, to } = cutOf(label);
      return rows.filter((x) => x.ts! >= ts(from) && x.ts! < ts(to));
    };
    const rep = await ingest(context(r), source(both));
    expect(rep.days.map((d) => [d.session, d.status, d.take])).toEqual([
      ["2026-10-26", "partial", undefined],
      ["2026-10-27", "stored", 1],
      ["2026-10-28", "stored", 1],
      ["2026-10-29", "partial", undefined],
    ]);
    for (const d of rep.days) {
      expect(d.rows).toEqual({ prints: inCut(both.prints, d.session).length, bid: inCut(both.bid, d.session).length, ask: inCut(both.ask, d.session).length });
    }
    for (const label of ["2026-10-27", "2026-10-28"]) {
      const stored = await readRows(streamFile(takeDir(r, ID, label, 1), "prints"), "prints");
      expect(stored.map((x) => [String(x.ts), px(Number(x.px)), String(x.size), px(Number(x.bid)), px(Number(x.ask))])).toEqual(
        inCut(both.prints, label).map((x) => [String(x.ts), x.px, String(x.size), x.bid, x.ask]),
      );
    }
  });
});

describe("refusals store nothing", () => {
  const base = () => syntheticDay("2026-10-28");
  const cases: [string, (s: Streams) => Partial<Streams> | null, RegExp, FetchManifest?, string?][] = [
    ["a time that does not parse", (s) => ((s.prints[3] = { ...s.prints[3], ts: null }), s), /prints line 4: time does not parse/],
    ["a non-numeric price", (s) => ((s.bid[2] = { ...s.bid[2], px: "12x" }), s), /bid line 3: price "12x" is not numeric/],
    ["a price off the tick grid", (s) => ((s.ask[5] = { ...s.ask[5], px: "30000.1" }), s), /ask line 6: price 30000.1 is not a whole number of ticks/],
    ["a bid stamp off the grid", (s) => ((s.prints[1] = { ...s.prints[1], bid: "30000.30" }), s), /prints line 2: bid 30000.30 is not a whole number of ticks/],
    ["a negative size", (s) => ((s.prints[0] = { ...s.prints[0], size: "-1" }), s), /size -1 is negative/],
    ["a size that is not an integer", (s) => ((s.bid[0] = { ...s.bid[0], size: "1.5" }), s), /size "1.5" is not an integer/],
    ["a quote with a stamp", (s) => ((s.bid[0] = { ...s.bid[0], ask: px(1) }), s), /quote row carries a bid\/ask stamp/],
    ["bid without ask", (s) => ({ prints: s.prints, bid: s.bid }), /both or neither/],
    ["no prints", (s) => ({ bid: s.bid, ask: s.ask }), /prints are required/],
    ["an unknown symbol", (s) => s, /unknown symbol "ZZZ"/, undefined, "ZZZ 12-26"],
    ["a tick size that disagrees with the registry", (s) => s, /tick size 0.5 differs from the registry's 0.25/, { ...unattestedManifest(["prints", "bid", "ask"]), tickSize: "0.50" }],
  ];
  for (const [name, mutate, message, manifest, instrument] of cases) {
    it(name, async () => {
      const r = root();
      await expect(ingest(context(r), source(mutate(base())!, manifest, instrument))).rejects.toThrow(message);
      expect(existsSync(path.join(r, "ticks"))).toBe(false);
      expect(existsSync(path.join(r, LOCK_FILE))).toBe(false);
    });
  }

  it("a manifest whose row count is off by one", async () => {
    const r = root();
    const day = base();
    const manifest = unattestedManifest(["prints", "bid", "ask"]);
    const sizeSum = day.prints.reduce((a, p) => a + BigInt(p.size), 0n);
    manifest.streams.prints = {
      rows: day.prints.length + 1,
      sizeSum: String(sizeSum),
      firstTs: String(day.prints[0].ts),
      lastTs: String(day.prints[day.prints.length - 1].ts),
    };
    await expect(ingest(context(r), source(day, manifest))).rejects.toThrow(
      new RegExp(`prints differs from the attested manifest: rows ${day.prints.length} vs ${day.prints.length + 1}`),
    );
    expect(existsSync(path.join(r, "ticks"))).toBe(false);
  });

  it("a second ingest while the lock is held", async () => {
    const r = root();
    let release!: () => void;
    const held = withLock(r, "test", () => new Promise<void>((res) => (release = res)));
    await expect(ingest(context(r), source(base()))).rejects.toThrow(/another nt8-lake job holds the lake \(test, pid/);
    release();
    await held;
    expect(existsSync(path.join(r, LOCK_FILE))).toBe(false);
  });
});

describe("a lock whose holder is gone", () => {
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
  const lockAt = (r: string, holder: { pid: number; host?: string; startedAt?: string }) => {
    mkdirSync(r, { recursive: true });
    const { host = hostname(), startedAt = new Date().toISOString(), pid } = holder;
    writeFileSync(path.join(r, LOCK_FILE), JSON.stringify({ pid, host, command: "ingest addon", startedAt }));
  };
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => vi.restoreAllMocks());

  it("is broken when its process is gone, and says so", async () => {
    const r = root();
    const said = quiet();
    const pid = deadPid();
    lockAt(r, { pid });
    expect(await withLock(r, "test", async () => "ran")).toBe("ran");
    expect(existsSync(path.join(r, LOCK_FILE))).toBe(false);
    expect(said).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`broke the lock left by ingest addon, pid ${pid} .*: that process is gone$`)));
  });

  it("is broken when it was taken before the last boot, whatever its pid says", async () => {
    const r = root();
    const said = quiet();
    lockAt(r, { pid: process.pid, startedAt: new Date(Date.now() - uptime() * 1000 - 3_600_000).toISOString() });
    expect(await withLock(r, "test", async () => "ran")).toBe("ran");
    expect(said).toHaveBeenCalledWith(expect.stringMatching(/: it was taken before the last boot$/));
  });

  it("is kept when it belongs to another host", async () => {
    const r = root();
    const said = quiet();
    lockAt(r, { pid: deadPid(), host: "elsewhere", startedAt: "2020-01-01T00:00:00.000Z" });
    await expect(withLock(r, "test", async () => "ran")).rejects.toThrow(/another nt8-lake job holds the lake \(ingest addon, pid \d+ on elsewhere/);
    expect(existsSync(path.join(r, LOCK_FILE))).toBe(true);
    expect(said).not.toHaveBeenCalled();
  });
});

describe("stored as given", () => {
  it("stores whole ticks the same as their decimal text", async () => {
    const day = syntheticDay("2026-10-28");
    const toTicks = (v: string | null | undefined) => (v == null ? v : String(Math.round(Number(v) * 4)));
    const asTicks = Object.fromEntries(
      Object.entries(day).map(([s, rows]) => [s, (rows as Row[]).map((r) => ({ ...r, px: toTicks(r.px)!, bid: toTicks(r.bid), ask: toTicks(r.ask) }))]),
    );
    const a = root();
    const b = root();
    await ingest(context(a), source(day));
    await ingest(context(b), rowsSource({ instrument: MNQ, priceUnit: "ticks", streams: asTicks }));
    const take = (r: string) => JSON.parse(readFileSync(path.join(takeDir(r, ID, "2026-10-28", 1), "take.json"), "utf-8")).streams;
    const fps = (r: string) => Object.fromEntries(Object.entries(take(r)).map(([s, w]) => [s, (w as { fingerprint: string }).fingerprint]));
    expect(fps(b)).toEqual(fps(a));
  });

  it("does not store a whole day with an empty quote stream", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    const cut = cutOf("2026-10-28");
    const outside = (rows: Row[]) => rows.filter((x) => x.ts! < ts(cut.from) || x.ts! >= ts(cut.to));
    const rep = await ingest(context(r), source({ prints: day.prints, bid: outside(day.bid), ask: day.ask }));
    expect(rep.days.find((d) => d.session === "2026-10-28")).toMatchObject({ status: "empty_stream", reason: "bid has no rows in this session-day" });
    expect(existsSync(path.join(r, "ticks"))).toBe(false);
  });

  it("round-trips NULL stamps, zero sizes and time going backwards", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    day.prints[10] = { ...day.prints[10], bid: null, ask: null };
    day.prints[11] = { ...day.prints[11], ask: null, size: 0 };
    day.prints[12] = { ...day.prints[12], ts: day.prints[12].ts! - ts(100) };
    await ingest(context(r), source(day));
    const rows = await readRows(streamFile(takeDir(r, ID, "2026-10-28", 1), "prints"), "prints");
    // prints[0] is the pad row of the previous session-day.
    expect(rows[9]).toMatchObject({ bid: null, ask: null });
    expect(rows[10]).toMatchObject({ ask: null, size: 0, bid: String(120_000 + (10 % 7)) });
    expect(BigInt(rows[11].ts as string)).toBe(day.prints[12].ts);
    const st = dayState(sessionDir(r, ID, "2026-10-28"));
    const failing = st.failing.map((f) => f.id);
    expect(failing).toEqual(expect.arrayContaining(["time_order.prints", "stamped", "sizes_positive"]));
  });

  it("writes the footer and the brief's Parquet types", async () => {
    const r = root();
    await ingest(context(r), source(syntheticDay("2026-10-28")));
    const file = streamFile(takeDir(r, ID, "2026-10-28", 1), "prints");
    const engine = await openEngine();
    try {
      const foot = await readFooter(engine, file);
      expect(foot).toMatchObject({
        "nt8.format": "ticks.v1",
        "nt8.stream": "prints",
        "nt8.instrument": MNQ,
        "nt8.symbol": "MNQ",
        "nt8.session": "2026-10-28",
        "nt8.take": "1",
        "nt8.tick_size": "0.25",
        "nt8.ts_unit": "100ns",
        "nt8.source": "rows",
        "nt8.price_basis": "unattested",
        "nt8.cut_from": String(cutOf("2026-10-28").from),
      });
      await readStream(engine, file, "prints", "r");
      expect(await fingerprint(engine, "r", "prints")).toEqual({ rows: Number(foot["nt8.rows"]), fingerprint: foot["nt8.fingerprint"] });
      const types = (await engine.con.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${file}', hive_partitioning = false)`)).getRowObjectsJson();
      expect(Object.fromEntries(types.map((t) => [t.column_name, t.column_type]))).toEqual({
        dt: "BIGINT",
        dpx: "INTEGER",
        size: "UINTEGER",
        bid_off: "INTEGER",
        ask_off: "INTEGER",
      });
    } finally {
      engine.close();
    }
  });
});

describe("takes", () => {
  it("is a no-op on the same rows, and a different re-fetch becomes take 2 without being selected", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    const ctx = context(r, { bars: barsOf(day.prints, cutOf("2026-10-28")) });
    const first = await ingest(ctx, source(day));
    expect(first.days.find((d) => d.session === "2026-10-28")).toMatchObject({ status: "stored", take: 1, tier: "CLEAN" });
    const again = await ingest(ctx, source(syntheticDay("2026-10-28")));
    expect(again.days.find((d) => d.session === "2026-10-28")).toMatchObject({ status: "already_held", take: 1 });

    const changed = syntheticDay("2026-10-28");
    changed.prints[100] = { ...changed.prints[100], size: 7 };
    const second = await ingest(ctx, source(changed));
    expect(second.days.find((d) => d.session === "2026-10-28")).toMatchObject({ status: "stored", take: 2 });
    let st = dayState(sessionDir(r, ID, "2026-10-28"));
    expect(st.selected).toBe(1);
    expect(st.tier).toBe("RAW");
    expect(st.failing.map((f) => f.id)).toEqual(["single_take"]);

    st = await select(ctx, MNQ, "2026-10-28", 1);
    expect(st.tier).toBe("CLEAN");
    expect(st.results.find((x) => x.id === "single_take")?.status).toBe("pass");
  });
});

describe("tiers", () => {
  it("RAW without a reference, GOLD only with that check waived, back to RAW on ungold", async () => {
    const r = root();
    const ctx = context(r);
    await ingest(ctx, source(syntheticDay("2026-10-28")));
    let st = dayState(sessionDir(r, ID, "2026-10-28"));
    expect(st.tier).toBe("RAW");
    expect(st.failing.map((f) => [f.id, f.status])).toEqual([["matches_1s_reference", "no_reference"]]);
    await expect(gold(ctx, MNQ, "2026-10-28", "looked at it")).rejects.toThrow(/failing and not waived: matches_1s_reference/);
    await expect(gold(ctx, MNQ, "2026-10-28", "x", ["nope"])).rejects.toThrow(/unknown checks: nope/);
    st = await gold(ctx, "MNQ_12-26", "2026-10-28", "no cache for this day", ["matches_1s_reference"]);
    expect(st.tier).toBe("GOLD");
    st = await ungold(ctx, MNQ, "2026-10-28");
    expect(st.tier).toBe("RAW");
    expect(st.day.history).toHaveLength(1);
  });

  it("a gold mark belongs to its take", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    const ctx = context(r, { bars: barsOf(day.prints, cutOf("2026-10-28")) });
    await ingest(ctx, source(day));
    expect((await gold(ctx, MNQ, "2026-10-28", "reviewed")).tier).toBe("GOLD");
    const changed = syntheticDay("2026-10-28");
    changed.bid[50] = { ...changed.bid[50], size: 99 };
    await ingest(ctx, source(changed));
    expect(dayState(sessionDir(r, ID, "2026-10-28")).tier).toBe("RAW");
    expect((await select(ctx, MNQ, "2026-10-28", 2)).tier).toBe("CLEAN");
    expect((await select(ctx, MNQ, "2026-10-28", 1)).tier).toBe("GOLD");
  });

  it("passes a known early close, and waives every stream of a check by its bare name", async () => {
    const day = syntheticDay("2026-10-28");
    const early = et(2026, 10, 28, 13);
    const short: Streams = {
      prints: day.prints.filter((p) => p.ts! < ts(early) || p.ts! > ts(cutOf("2026-10-28").to)),
      bid: day.bid.filter((p) => p.ts! < ts(early) || p.ts! > ts(cutOf("2026-10-28").to)),
      ask: day.ask.filter((p) => p.ts! < ts(early) || p.ts! > ts(cutOf("2026-10-28").to)),
    };
    const bars = barsOf(short.prints, cutOf("2026-10-28"));
    const calendar: SessionCalendar = new Map([
      ["2026-10-28", { date: "2026-10-28", kind: "modified", closeTime: "13:00", source: "manual" }],
    ]);
    const known = root();
    await ingest(context(known, { calendar, bars }), source(short));
    expect(dayState(sessionDir(known, ID, "2026-10-28")).tier).toBe("CLEAN");

    const r = root();
    const ctx = context(r, { bars });
    await ingest(ctx, source(short));
    const st = dayState(sessionDir(r, ID, "2026-10-28"));
    expect(st.failing.map((f) => f.id)).toEqual(["spans_session.prints", "spans_session.bid", "spans_session.ask"]);
    expect((await gold(ctx, MNQ, "2026-10-28", "early close", ["spans_session"])).tier).toBe("GOLD");
  });

  it("fails spans_session on a date the calendar calls closed", async () => {
    const r = root();
    const calendar: SessionCalendar = new Map([["2026-10-28", { date: "2026-10-28", kind: "closed", source: "manual" }]]);
    await ingest(context(r, { calendar }), source(syntheticDay("2026-10-28")));
    const res = dayState(sessionDir(r, ID, "2026-10-28")).results.find((x) => x.id === "spans_session.prints")!;
    expect(res).toMatchObject({ status: "fail", detail: expect.stringMatching(/market holiday/) });
  });
});

describe("1s reference", () => {
  it("passes on equal bars, fails with counts on a difference, and reports no_reference", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    const cut = cutOf("2026-10-28");
    const bars = barsOf(day.prints, cut);
    const result = async (refs: typeof bars) => {
      const ctx = context(r, { bars: refs });
      await recheck(ctx);
      return dayState(sessionDir(r, ID, "2026-10-28")).results.find((x) => x.id === "matches_1s_reference")!;
    };
    await ingest(context(r, { bars }), source(day));
    expect((await result(bars)).status).toBe("pass");
    const off = bars.map((b, i) => (i === 3 ? { ...b, volume: b.volume + 1 } : b)).slice(0, -1);
    const failed = await result(off);
    expect(failed.status).toBe("fail");
    expect(failed.values).toMatchObject({ matched: bars.length - 2, mismatched: 1, lakeOnly: 1, referenceOnly: 0 });
    expect((await result([])).status).toBe("no_reference");
    const broken = context(r, { referenceBars: async () => Promise.reject(new Error("cache locked")) });
    await recheck(broken);
    const res = dayState(sessionDir(r, ID, "2026-10-28")).results.find((x) => x.id === "matches_1s_reference")!;
    expect(res).toMatchObject({ status: "no_reference", detail: "reference unavailable: cache locked" });
  });
});

describe("checks on a whole synthetic day", () => {
  it("passes every check and records the facts", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    await ingest(context(r, { bars: barsOf(day.prints, cutOf("2026-10-28")) }), source(day));
    const sheet = show(context(r), MNQ, "2026-10-28");
    expect(sheet.state.tier).toBe("CLEAN");
    expect(sheet.state.results.map((x) => x.id)).toEqual([
      "time_order.prints",
      "spans_session.prints",
      "no_long_gap.prints",
      "time_order.bid",
      "spans_session.bid",
      "no_long_gap.bid",
      "time_order.ask",
      "spans_session.ask",
      "no_long_gap.ask",
      "stamped",
      "sizes_positive",
      "side_known",
      "side_balanced",
      "quotes_match_stamps",
      "matches_1s_reference",
      "single_take",
    ]);
    const facts = sheet.state.checks!.facts;
    expect(facts.streams.prints!.longestGaps[0].secs).toBe(30);
    expect(facts.prints.atBid.rows + facts.prints.atAsk.rows).toBe(facts.streams.prints!.rows);
  });

  it("fails quotes_match_stamps when the other side's stamp disagrees with the quote file", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    for (let i = 1; i < day.prints.length - 1; i += 2) day.prints[i] = { ...day.prints[i], ask: px(130_000) };
    await ingest(context(r), source(day));
    const res = dayState(sessionDir(r, ID, "2026-10-28")).results.find((x) => x.id === "quotes_match_stamps")!;
    expect(res.status).toBe("fail");
  });

  it("skips quotes_match_stamps on a take without quotes", async () => {
    const r = root();
    const day = syntheticDay("2026-10-28");
    await ingest(context(r, { bars: barsOf(day.prints, cutOf("2026-10-28")) }), source({ prints: day.prints }));
    const st = dayState(sessionDir(r, ID, "2026-10-28"));
    expect(st.results.find((x) => x.id === "quotes_match_stamps")?.status).toBe("skipped");
    expect(st.tier).toBe("CLEAN");
  });
});

describe("verify and status", () => {
  it("fails after one byte of a Parquet file changes", async () => {
    const r = root();
    await ingest(context(r), source(syntheticDay("2026-10-28")));
    expect((await verify(context(r))).ok).toBe(true);
    const file = streamFile(takeDir(r, ID, "2026-10-28", 1), "bid");
    const bytes = readFileSync(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(file, bytes);
    const rep = await verify(context(r));
    expect(rep.ok).toBe(false);
    expect(rep.takes[0].problems.join("\n")).toMatch(/bid: sha256 .* differs from take.json/);
  });

  it("lists missing and closed session-days between stored ones", async () => {
    const r = root();
    const ctx = context(r);
    await ingest(ctx, source(syntheticDay("2026-12-23")));
    await ingest(ctx, source(syntheticDay("2026-12-28")));
    const calendar: SessionCalendar = new Map([["2026-12-25", { date: "2026-12-25", kind: "closed", source: "bootstrap", description: "Christmas Day" }]]);
    const lines = status(context(r, { calendar }));
    expect(lines.map((l) => [l.session, l.state])).toEqual([
      ["2026-12-23", "stored"],
      ["2026-12-24", "missing"],
      ["2026-12-25", "closed"],
      ["2026-12-28", "stored"],
    ]);
    expect(existsSync(contractDir(r, ID))).toBe(true);
  });
});
