import path from "node:path";
import { SessionClosedError, sessionDayRange } from "../core/sessions/session-day.js";
import type { SessionCalendar } from "../core/sessions/calendar.js";
import type { SessionTemplate } from "../core/sessions/types.js";
import { formatExchangeTime } from "../core/time.js";
import { rows, type Engine } from "./engine.js";
import { streamFile } from "./layout.js";
import { readStream } from "./reader.js";
import type { StreamName } from "./source.js";
import type { TakeFile } from "./writer.js";

export const CHECKS_VERSION = 1;

export const THRESHOLDS = {
  spanEdgeSecs: 60,
  maxGapSecs: { prints: 300, bid: 60, ask: 60 } as Record<StreamName, number>,
  sideKnownMin: 0.999,
  atBidMin: 0.25,
  atBidMax: 0.75,
  quotesMatchMin: 0.999,
};

export type CheckStatus = "pass" | "fail" | "skipped" | "no_reference";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  detail: string;
  values?: Record<string, unknown>;
}

export interface RefBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 1s bars for `contract` (NT8's instrument name) with `cutFrom < timestamp <= cutTo`. */
export type ReferenceBars = (contract: string, cutFrom: number, cutTo: number) => Promise<RefBar[]>;

export interface CheckContext {
  template: SessionTemplate;
  calendar: SessionCalendar;
  referenceBars: ReferenceBars;
}

export interface Gap {
  fromTs: string;
  toTs: string;
  secs: number;
}

export interface StreamFacts {
  rows: number;
  contracts: string;
  firstTs: string | null;
  lastTs: string | null;
  inSessionRows: number;
  longestGaps: Gap[];
  rowsPerHour: { hour: number; rows: number }[];
  mostRowsOnOneTs: { ts: string; rows: number } | null;
}

export interface PrintFacts {
  atBid: { rows: number; contracts: string };
  atAsk: { rows: number; contracts: string };
  bothSides: number;
  unsided: number;
  delta: string;
}

export interface ChecksFile {
  checksVersion: number;
  thresholds: typeof THRESHOLDS;
  computedAt: string;
  session: string;
  take: number;
  inSession: { from: number; to: number } | { closed: string };
  results: CheckResult[];
  facts: {
    streams: Partial<Record<StreamName, StreamFacts>>;
    prints: PrintFacts;
    bars1s: { lake: number; reference: number };
  };
}

const TS = 10_000_000;

export function fmtTs(ts: string | bigint | null): string {
  if (ts === null) return "-";
  const t = BigInt(ts);
  const sec = t / 10_000_000n;
  const frac = (t % 10_000_000n).toString().padStart(7, "0");
  return `${formatExchangeTime(Number(sec))}.${frac}`;
}

export function fmtSecs(secs: number): string {
  return secs.toFixed(7).replace(/\.?0+$/, "");
}

function n(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

function inSessionRange(label: string, ctx: CheckContext): { from: number; to: number } | { closed: string } {
  try {
    const r = sessionDayRange(label, ctx.template, ctx.calendar);
    return { from: r.startUnix, to: r.endUnix };
  } catch (err) {
    if (err instanceof SessionClosedError) return { closed: err.message };
    throw err;
  }
}

async function streamFacts(
  engine: Engine,
  table: string,
  span: { from: number; to: number } | null,
): Promise<StreamFacts & { backwards: number; maxGapSecs: number | null; firstIn: string | null; lastIn: string | null }> {
  const inWhere = span ? `ts >= ${BigInt(span.from) * 10_000_000n} AND ts < ${BigInt(span.to) * 10_000_000n}` : "false";
  const [s] = await rows(
    engine.con,
    `SELECT count(*)::BIGINT AS n, coalesce(sum(size), 0)::VARCHAR AS contracts,
            arg_min(ts, rn)::VARCHAR AS first_ts, arg_max(ts, rn)::VARCHAR AS last_ts,
            count(*) FILTER (WHERE ts < prev)::BIGINT AS backwards
     FROM (SELECT rn, ts, size, lag(ts) OVER (ORDER BY rn) AS prev FROM ${table})`,
  );
  const [ins] = await rows(
    engine.con,
    `SELECT count(*)::BIGINT AS n, min(ts)::VARCHAR AS first_in, max(ts)::VARCHAR AS last_in
     FROM ${table} WHERE ${inWhere}`,
  );
  const gaps = await rows(
    engine.con,
    `SELECT prev::VARCHAR AS from_ts, ts::VARCHAR AS to_ts, (ts - prev) / ${TS}.0 AS secs
     FROM (SELECT ts, lag(ts) OVER (ORDER BY rn) AS prev FROM ${table} WHERE ${inWhere})
     WHERE prev IS NOT NULL ORDER BY ts - prev DESC, ts LIMIT 5`,
  );
  const perHour = await rows(
    engine.con,
    `SELECT (ts // ${TS * 3600}) * 3600 AS hour, count(*)::BIGINT AS n FROM ${table} GROUP BY 1 ORDER BY 1`,
  );
  const [most] = await rows(
    engine.con,
    `SELECT ts::VARCHAR AS ts, count(*)::BIGINT AS n FROM ${table} GROUP BY ts ORDER BY n DESC, ts LIMIT 1`,
  );
  return {
    rows: n(s.n),
    contracts: String(s.contracts),
    firstTs: (s.first_ts as string | null) ?? null,
    lastTs: (s.last_ts as string | null) ?? null,
    inSessionRows: n(ins.n),
    longestGaps: gaps.map((g) => ({ fromTs: String(g.from_ts), toTs: String(g.to_ts), secs: Number(g.secs) })),
    rowsPerHour: perHour.map((h) => ({ hour: n(h.hour), rows: n(h.n) })),
    mostRowsOnOneTs: most ? { ts: String(most.ts), rows: n(most.n) } : null,
    backwards: n(s.backwards),
    maxGapSecs: gaps.length > 0 ? Number(gaps[0].secs) : null,
    firstIn: (ins.first_in as string | null) ?? null,
    lastIn: (ins.last_in as string | null) ?? null,
  };
}

async function quotesMatchStamps(engine: Engine): Promise<{ tested: number; matched: number; unsided: number }> {
  // A print at the bid is checked against the ask file and vice versa: the
  // stamp of a print's own side is set to the trade price.
  const sideSql = (quote: "bid" | "ask", traded: string) => `
    SELECT p.rn, (q.last_px = p.${quote}) OR (m.ts IS NOT NULL) AS ok
    FROM (SELECT rn, ts, ${quote} FROM s_prints WHERE ${traded}) p
    ASOF LEFT JOIN (SELECT ts, arg_max(px, rn) AS last_px FROM s_${quote} GROUP BY ts) q ON p.ts > q.ts
    LEFT JOIN (SELECT DISTINCT ts, px FROM s_${quote}) m ON m.ts = p.ts AND m.px = p.${quote}`;
  const [r] = await rows(
    engine.con,
    `WITH t AS (${sideSql("ask", "bid_off = 0 AND ask_off <> 0")} UNION ALL ${sideSql("bid", "ask_off = 0 AND bid_off <> 0")})
     SELECT count(*)::BIGINT AS tested, count(*) FILTER (WHERE ok)::BIGINT AS matched,
            (SELECT count(*) FROM s_prints)::BIGINT - count(*) AS unsided
     FROM t`,
  );
  return { tested: n(r.tested), matched: n(r.matched), unsided: n(r.unsided) };
}

interface LakeBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function compareBars(lake: LakeBar[], ref: RefBar[], tick: number) {
  const toTicks = (p: number) => {
    const x = p / tick;
    const r = Math.round(x);
    return Math.abs(x - r) < 1e-6 ? r : Number.NaN;
  };
  const byT = new Map(ref.map((b) => [b.timestamp, b]));
  let matched = 0;
  let mismatched = 0;
  let lakeOnly = 0;
  const examples: string[] = [];
  for (const b of lake) {
    const r = byT.get(b.t);
    if (!r) {
      lakeOnly++;
      if (examples.length < 5) examples.push(`${b.t}: only in the lake`);
      continue;
    }
    byT.delete(b.t);
    const same =
      toTicks(r.open) === b.o && toTicks(r.high) === b.h && toTicks(r.low) === b.l && toTicks(r.close) === b.c && r.volume === b.v;
    if (same) matched++;
    else {
      mismatched++;
      if (examples.length < 5) {
        examples.push(
          `${b.t}: lake ${b.o}/${b.h}/${b.l}/${b.c} v${b.v}, reference ${toTicks(r.open)}/${toTicks(r.high)}/${toTicks(r.low)}/${toTicks(r.close)} v${r.volume} (ticks)`,
        );
      }
    }
  }
  for (const t of byT.keys()) if (examples.length < 5) examples.push(`${t}: only in the reference`);
  return { matched, mismatched, lakeOnly, referenceOnly: byT.size, examples };
}

export async function computeChecks(engine: Engine, dir: string, take: TakeFile, ctx: CheckContext): Promise<ChecksFile> {
  const streams = Object.keys(take.streams) as StreamName[];
  for (const s of streams) await readStream(engine, streamFile(dir, s), s, `s_${s}`);
  const inSession = inSessionRange(take.session, ctx);
  const span = "closed" in inSession ? null : inSession;
  const results: CheckResult[] = [];
  const facts: ChecksFile["facts"]["streams"] = {};

  for (const s of streams) {
    const f = await streamFacts(engine, `s_${s}`, span);
    const { backwards, maxGapSecs, firstIn, lastIn, ...kept } = f;
    facts[s] = kept;
    results.push({
      id: `time_order.${s}`,
      status: backwards === 0 ? "pass" : "fail",
      detail: `${backwards} rows earlier than the row before`,
      values: { backwards },
    });
    if (!span) {
      results.push({ id: `spans_session.${s}`, status: "fail", detail: (inSession as { closed: string }).closed });
      results.push({ id: `no_long_gap.${s}`, status: "fail", detail: "no session on this date" });
      continue;
    }
    const lateOpen = firstIn === null ? null : Number(BigInt(firstIn) - BigInt(span.from) * 10_000_000n) / TS;
    const earlyEnd = lastIn === null ? null : Number(BigInt(span.to) * 10_000_000n - BigInt(lastIn)) / TS;
    const edge = THRESHOLDS.spanEdgeSecs;
    results.push({
      id: `spans_session.${s}`,
      status: lateOpen !== null && earlyEnd !== null && lateOpen <= edge && earlyEnd <= edge ? "pass" : "fail",
      detail:
        firstIn === null
          ? "no row inside the session"
          : `first ${fmtSecs(lateOpen!)}s after the open (${fmtTs(firstIn)}), last ${fmtSecs(earlyEnd!)}s before the close (${fmtTs(lastIn)}); limit ${edge}s`,
      values: { firstAfterOpenSecs: lateOpen, lastBeforeCloseSecs: earlyEnd },
    });
    const limit = THRESHOLDS.maxGapSecs[s];
    results.push({
      id: `no_long_gap.${s}`,
      status: maxGapSecs !== null && maxGapSecs <= limit ? "pass" : "fail",
      detail: maxGapSecs === null ? "fewer than two rows inside the session" : `longest silence ${fmtSecs(maxGapSecs)}s; limit ${limit}s`,
      values: { longestSecs: maxGapSecs },
    });
  }

  const [p] = await rows(
    engine.con,
    `SELECT count(*)::BIGINT AS n,
            count(*) FILTER (WHERE bid_off IS NULL OR ask_off IS NULL)::BIGINT AS unstamped,
            count(*) FILTER (WHERE size < 1)::BIGINT AS below_one, min(size) AS min_size,
            count(*) FILTER (WHERE bid_off = 0 AND ask_off <> 0)::BIGINT AS at_bid,
            coalesce(sum(size) FILTER (WHERE bid_off = 0 AND ask_off <> 0), 0)::VARCHAR AS at_bid_c,
            count(*) FILTER (WHERE ask_off = 0 AND bid_off <> 0)::BIGINT AS at_ask,
            coalesce(sum(size) FILTER (WHERE ask_off = 0 AND bid_off <> 0), 0)::VARCHAR AS at_ask_c,
            count(*) FILTER (WHERE bid_off = 0 AND ask_off = 0)::BIGINT AS both_sides
     FROM s_prints`,
  );
  const total = n(p.n);
  const atBid = n(p.at_bid);
  const atAsk = n(p.at_ask);
  const printFacts: PrintFacts = {
    atBid: { rows: atBid, contracts: String(p.at_bid_c) },
    atAsk: { rows: atAsk, contracts: String(p.at_ask_c) },
    bothSides: n(p.both_sides),
    unsided: total - atBid - atAsk,
    delta: (BigInt(String(p.at_ask_c)) - BigInt(String(p.at_bid_c))).toString(),
  };
  results.push({
    id: "stamped",
    status: n(p.unstamped) === 0 ? "pass" : "fail",
    detail: `${n(p.unstamped)} prints without a bid or ask stamp`,
    values: { unstamped: n(p.unstamped) },
  });
  results.push({
    id: "sizes_positive",
    status: n(p.below_one) === 0 ? "pass" : "fail",
    detail: `${n(p.below_one)} prints below size 1; smallest ${p.min_size}`,
    values: { belowOne: n(p.below_one), minSize: n(p.min_size) },
  });
  const known = total === 0 ? 0 : (atBid + atAsk) / total;
  results.push({
    id: "side_known",
    status: known >= THRESHOLDS.sideKnownMin ? "pass" : "fail",
    detail: `${(known * 100).toFixed(4)}% on exactly one side; ${total - atBid - atAsk} not (${n(p.both_sides)} with bid = ask); minimum ${THRESHOLDS.sideKnownMin * 100}%`,
    values: { fraction: known, unsided: total - atBid - atAsk },
  });
  const bidShare = total === 0 ? 0 : atBid / total;
  results.push({
    id: "side_balanced",
    status: bidShare >= THRESHOLDS.atBidMin && bidShare <= THRESHOLDS.atBidMax ? "pass" : "fail",
    detail: `${(bidShare * 100).toFixed(2)}% of prints at the bid; allowed ${THRESHOLDS.atBidMin * 100}% to ${THRESHOLDS.atBidMax * 100}%`,
    values: { atBidFraction: bidShare },
  });

  if (take.streams.bid && take.streams.ask) {
    const q = await quotesMatchStamps(engine);
    const share = q.tested === 0 ? 0 : q.matched / q.tested;
    results.push({
      id: "quotes_match_stamps",
      status: share >= THRESHOLDS.quotesMatchMin ? "pass" : "fail",
      detail: `${(share * 100).toFixed(4)}% of ${q.tested} sided prints match the other side's quote; ${q.unsided} unsided prints not tested; minimum ${THRESHOLDS.quotesMatchMin * 100}%`,
      values: { tested: q.tested, matched: q.matched, unsided: q.unsided },
    });
  } else {
    results.push({ id: "quotes_match_stamps", status: "skipped", detail: "this take has no quotes" });
  }

  // A print exactly on a second belongs to the next 1s bar.
  const lake = (
    await rows(
      engine.con,
      `SELECT (ts // ${TS}) + 1 AS t, arg_min(px, rn) AS o, max(px) AS h, min(px) AS l, arg_max(px, rn) AS c, sum(size) AS v
       FROM s_prints GROUP BY 1 ORDER BY 1`,
    )
  ).map((b) => ({ t: n(b.t), o: n(b.o), h: n(b.h), l: n(b.l), c: n(b.c), v: n(b.v) }));
  let ref: RefBar[] = [];
  let refError: string | null = null;
  try {
    ref = await ctx.referenceBars(take.instrument, take.cut.from, take.cut.to);
  } catch (err) {
    refError = err instanceof Error ? err.message : String(err);
  }
  if (refError !== null || ref.length === 0) {
    results.push({
      id: "matches_1s_reference",
      status: "no_reference",
      detail: refError !== null ? `reference unavailable: ${refError}` : `no 1s reference rows for ${take.instrument}`,
      values: { lakeBars: lake.length, referenceBars: 0 },
    });
  } else {
    const cmp = compareBars(lake, ref, Number(take.tickSize));
    const pass = cmp.mismatched === 0 && cmp.lakeOnly === 0 && cmp.referenceOnly === 0;
    results.push({
      id: "matches_1s_reference",
      status: pass ? "pass" : "fail",
      detail: pass
        ? `all ${cmp.matched} 1s bars equal the reference`
        : `${cmp.matched} equal, ${cmp.mismatched} differ, ${cmp.lakeOnly} only in the lake, ${cmp.referenceOnly} only in the reference; ${cmp.examples.join("; ")}`,
      values: { lakeBars: lake.length, referenceBars: ref.length, ...cmp },
    });
  }

  for (const s of streams) await engine.con.run(`DROP TABLE s_${s}`);
  return {
    checksVersion: CHECKS_VERSION,
    thresholds: THRESHOLDS,
    computedAt: new Date().toISOString(),
    session: take.session,
    take: take.take,
    inSession,
    results,
    facts: { streams: facts, prints: printFacts, bars1s: { lake: lake.length, reference: ref.length } },
  };
}

export function checksPath(dir: string): string {
  return path.join(dir, "checks.json");
}
