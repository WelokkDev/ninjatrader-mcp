import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rows, sqlStr, type Engine } from "./engine.js";
import { FORMAT, streamFile, TEMP_MARK } from "./layout.js";
import { FILE_TYPES, fileColumns, fileTypes, fingerprint, readFooter, readStream, sha256File } from "./reader.js";
import {
  RefusedError,
  STAGING_COLUMNS,
  STREAMS,
  UNATTESTED,
  type FetchManifest,
  type Source,
  type StreamName,
} from "./source.js";
import type { Cut } from "./session-cut.js";

export const WRITER_VERSION = "1";
const MAX_TICKS = 2 ** 30;
const MAX_SIZE = 2 ** 32 - 1;

export interface TickSize {
  /** Normalized decimal text, e.g. "0.25". */
  text: string;
  /** tick = units / 10^scale */
  units: bigint;
  scale: number;
}

export function parseTickSize(text: string): TickSize {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new RefusedError(`tick size "${text}" is not a positive decimal`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  const units = BigInt(m[1] + frac);
  if (units === 0n) throw new RefusedError(`tick size "${text}" is zero`);
  const intPart = m[1].replace(/^0+(?=\d)/, "");
  return { text: frac ? `${intPart}.${frac}` : intPart, units, scale: frac.length };
}

const DECIMAL_RE = /^-?[0-9]{1,12}(\.[0-9]{1,30})?$/;
const TICKS_RE = /^-?[0-9]{1,15}$/;
const SIZE_RE = /^[0-9]{1,10}$/;

async function defineMacros(engine: Engine, tick: TickSize, unit: Source["priceUnit"]): Promise<void> {
  const k = tick.scale;
  // TRY_CAST: DuckDB may evaluate every operand of an AND, so the casts see rows the regex rejects.
  const scaled = `(TRY_CAST(split_part(ltrim(x, '-'), '.', 1) AS BIGINT) * ${10n ** BigInt(k)}
                  + TRY_CAST('0' || rpad(rtrim(split_part(x, '.', 2), '0'), ${k}, '0') AS BIGINT))`;
  const ticks =
    unit === "decimal"
      ? `CASE WHEN regexp_full_match(x, '${DECIMAL_RE.source.slice(1, -1)}')
               AND length(rtrim(split_part(x, '.', 2), '0')) <= ${k}
               AND ${scaled} % ${tick.units} = 0
          THEN (CASE WHEN starts_with(x, '-') THEN -1 ELSE 1 END) * (${scaled} // ${tick.units}) END`
      : `CASE WHEN regexp_full_match(x, '${TICKS_RE.source.slice(1, -1)}') THEN TRY_CAST(x AS BIGINT) END`;
  await engine.con.run(`CREATE OR REPLACE MACRO nt8_ticks(x) AS (${ticks})`);
  await engine.con.run(`
    CREATE OR REPLACE MACRO nt8_size(x) AS (
      CASE WHEN regexp_full_match(x, '${SIZE_RE.source.slice(1, -1)}') AND TRY_CAST(x AS UBIGINT) <= ${MAX_SIZE}
           THEN TRY_CAST(x AS UBIGINT) END)`);
}

/** Why a staged row was refused, by the same rules the macros apply. */
function explainBadRow(stream: StreamName, r: Record<string, unknown>, tick: TickSize, unit: Source["priceUnit"]): string {
  const at = `${stream} line ${r.line}`;
  if (r.ts === null) return `${at}: time does not parse`;
  const price = (field: string, v: unknown): string | null => {
    if (v === null) return field === "price" ? `${at}: price is missing` : null;
    const s = String(v);
    if (!(unit === "decimal" ? DECIMAL_RE : TICKS_RE).test(s)) return `${at}: ${field} "${s}" is not numeric`;
    if (unit === "decimal") return `${at}: ${field} ${s} is not a whole number of ticks (tick ${tick.text}) or is out of range`;
    return `${at}: ${field} ${s} ticks is out of range`;
  };
  const inRange = (t: unknown) => t !== null && Math.abs(Number(t)) <= MAX_TICKS;
  if (!inRange(r.px_t)) return price("price", r.px) ?? `${at}: bad price`;
  const size = String(r.size ?? "");
  if (r.size_t === null) {
    if (size.startsWith("-")) return `${at}: size ${size} is negative`;
    if (!SIZE_RE.test(size)) return `${at}: size "${size}" is not an integer`;
    return `${at}: size ${size} is too large`;
  }
  if (stream !== "prints" && (r.bid !== null || r.ask !== null)) return `${at}: a quote row carries a bid/ask stamp`;
  if (r.bid !== null && !inRange(r.bid_t)) return price("bid", r.bid) ?? `${at}: bad bid`;
  if (r.ask !== null && !inRange(r.ask_t)) return price("ask", r.ask) ?? `${at}: bad ask`;
  return `${at}: does not parse`;
}

export interface StreamStats {
  rows: number;
  sizeSum: string;
  firstTs: string;
  lastTs: string;
  minTs: bigint;
  maxTs: bigint;
}

/** Loads each stream into `can_<stream>`, prices in ticks, refusing the whole input on the first
 *  row that cannot be held faithfully. `can_` rows are unordered; readers order by `line`. */
export async function stage(engine: Engine, source: Source, tick: TickSize): Promise<Partial<Record<StreamName, StreamStats>>> {
  if (!source.streams.includes("prints")) throw new RefusedError("prints are required");
  if (source.streams.includes("bid") !== source.streams.includes("ask")) {
    throw new RefusedError("bid and ask come both or neither");
  }
  await defineMacros(engine, tick, source.priceUnit);
  const stats: Partial<Record<StreamName, StreamStats>> = {};
  for (const stream of source.streams) {
    const stg = `stg_${stream}`;
    await engine.con.run(`CREATE OR REPLACE TABLE ${stg} (${STAGING_COLUMNS})`);
    await source.load(engine, stream, stg);
    const [dup] = await rows(
      engine.con,
      `SELECT count(*) FILTER (WHERE line IS NULL) AS nulls, count(*) - count(DISTINCT line) AS dups FROM ${stg}`,
    );
    if (Number(dup.nulls) > 0 || Number(dup.dups) > 0) {
      throw new RefusedError(`${stream}: the source gave missing or repeated line numbers`);
    }
    const quote = stream !== "prints";
    await engine.con.run(`
      CREATE OR REPLACE TABLE can_${stream} AS
      SELECT line, ts, px, size, bid, ask,
             ts IS NULL OR px IS NULL OR size IS NULL OR abs(px) > ${MAX_TICKS}
               OR (raw_bid IS NOT NULL AND (bid IS NULL OR abs(bid) > ${MAX_TICKS} OR ${quote}))
               OR (raw_ask IS NOT NULL AND (ask IS NULL OR abs(ask) > ${MAX_TICKS} OR ${quote})) AS bad
      FROM (
        SELECT line, ts, nt8_ticks(px) AS px, nt8_size(size) AS size,
               nt8_ticks(bid) AS bid, nt8_ticks(ask) AS ask, bid AS raw_bid, ask AS raw_ask
        FROM ${stg}
      )`);
    const bad = await rows(
      engine.con,
      `SELECT s.line, s.ts, s.px, s.size, s.bid, s.ask,
              c.px AS px_t, c.size AS size_t, c.bid AS bid_t, c.ask AS ask_t
       FROM can_${stream} c JOIN ${stg} s USING (line)
       WHERE c.bad ORDER BY s.line LIMIT 1`,
    );
    if (bad.length > 0) throw new RefusedError(explainBadRow(stream, bad[0], tick, source.priceUnit));
    await engine.con.run(`DROP TABLE ${stg}`);
    await engine.con.run(`ALTER TABLE can_${stream} DROP COLUMN bad`);
    const [s] = await rows(
      engine.con,
      `SELECT count(*)::BIGINT AS n, coalesce(sum(size), 0)::VARCHAR AS size_sum,
              min(ts)::VARCHAR AS min_ts, max(ts)::VARCHAR AS max_ts,
              arg_min(ts, line)::VARCHAR AS first_ts, arg_max(ts, line)::VARCHAR AS last_ts
       FROM can_${stream}`,
    );
    stats[stream] = {
      rows: Number(s.n),
      sizeSum: String(s.size_sum),
      firstTs: String(s.first_ts),
      lastTs: String(s.last_ts),
      minTs: BigInt(String(s.min_ts ?? 0)),
      maxTs: BigInt(String(s.max_ts ?? 0)),
    };
  }
  return stats;
}

export function checkManifest(source: Source, stats: Partial<Record<StreamName, StreamStats>>): void {
  const m = source.manifest;
  if (m.instrument !== UNATTESTED && m.instrument !== source.instrument) {
    throw new RefusedError(`manifest instrument "${m.instrument}" differs from the source's "${source.instrument}"`);
  }
  for (const stream of source.streams) {
    const want = m.streams[stream];
    const got = stats[stream];
    if (want === undefined || want === UNATTESTED || got === undefined) continue;
    const diffs: string[] = [];
    if (want.rows !== got.rows) diffs.push(`rows ${got.rows} vs ${want.rows}`);
    if (want.sizeSum !== got.sizeSum) diffs.push(`sum of sizes ${got.sizeSum} vs ${want.sizeSum}`);
    if (got.rows > 0 && want.firstTs !== got.firstTs) diffs.push(`first time ${got.firstTs} vs ${want.firstTs}`);
    if (got.rows > 0 && want.lastTs !== got.lastTs) diffs.push(`last time ${got.lastTs} vs ${want.lastTs}`);
    if (diffs.length > 0) throw new RefusedError(`${stream} differs from the attested manifest: ${diffs.join(", ")}`);
  }
}

export async function freeStaged(engine: Engine, streams: readonly StreamName[]): Promise<void> {
  for (const s of streams) await engine.con.run(`DROP TABLE IF EXISTS can_${s}`);
}

export interface SelectedInput {
  table: string;
  rows: number;
  fingerprint: string;
}

export async function selectInput(
  engine: Engine,
  stream: StreamName,
  cut: Cut | null,
  table = `inp_${stream}`,
): Promise<SelectedInput> {
  const where = cut ? `WHERE ts >= ${BigInt(cut.from) * 10_000_000n} AND ts < ${BigInt(cut.to) * 10_000_000n}` : "";
  await engine.con.run(`
    CREATE OR REPLACE TABLE ${table} AS
    SELECT row_number() OVER (ORDER BY line) - 1 AS rn, ts, px, size, px - bid AS bid_off, ask - px AS ask_off
    FROM can_${stream} ${where}
    ORDER BY rn`);
  return { table, ...(await fingerprint(engine, table, stream)) };
}

export interface Footer {
  instrument: string;
  symbol: string;
  session: string;
  take: number | string;
  tickSize: string;
  cutFrom: number | string;
  cutTo: number | string;
  source: string;
  priceBasis: string;
}

export interface WrittenStream {
  file: string;
  rows: number;
  fingerprint: string;
  sha256: string;
  bytes: number;
}

/** Renames the temp file into place only after readStream gives back the same rows,
 *  fingerprint, footer and types, then drops `inputTable`. */
export async function writeStreamFile(
  engine: Engine,
  stream: StreamName,
  inputTable: string,
  file: string,
  footer: Footer,
): Promise<WrittenStream> {
  const input = await fingerprint(engine, inputTable, stream);
  if (input.rows === 0) throw new RefusedError(`${stream}: refusing to write an empty file`);
  const meta: Record<string, string> = {
    "nt8.format": FORMAT,
    "nt8.stream": stream,
    "nt8.instrument": footer.instrument,
    "nt8.symbol": footer.symbol,
    "nt8.session": footer.session,
    "nt8.take": String(footer.take),
    "nt8.tick_size": footer.tickSize,
    "nt8.ts_unit": "100ns",
    "nt8.rows": String(input.rows),
    "nt8.fingerprint": input.fingerprint,
    "nt8.cut_from": String(footer.cutFrom),
    "nt8.cut_to": String(footer.cutTo),
    "nt8.source": footer.source,
    "nt8.price_basis": footer.priceBasis,
  };
  const kv = Object.entries(meta).map(([k, v]) => `${sqlStr(k)}: ${sqlStr(v)}`).join(", ");
  const offs = stream === "prints" ? ", bid_off::INTEGER AS bid_off, ask_off::INTEGER AS ask_off" : "";
  const tmp = `${file}${TEMP_MARK}${process.pid}`;
  try {
    await engine.con.run(`
      COPY (
        SELECT (ts - coalesce(lag(ts) OVER w, 0))::BIGINT AS dt,
               (px - coalesce(lag(px) OVER w, 0))::INTEGER AS dpx,
               size::UINTEGER AS size${offs}
        FROM ${inputTable}
        WINDOW w AS (ORDER BY rn)
        ORDER BY rn
      ) TO ${sqlStr(tmp)} (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19, PARQUET_VERSION V2,
                           ROW_GROUP_SIZE 4000000, KV_METADATA {${kv}})`);
    const types = await fileTypes(engine, tmp);
    const want = fileColumns(stream);
    const typeErr = want.find((c) => types[c] !== FILE_TYPES[c]) ?? Object.keys(types).find((c) => !want.includes(c));
    if (typeErr) throw new Error(`${stream}: read-back column "${typeErr}" is ${types[typeErr]}, schema says ${FILE_TYPES[typeErr]}`);
    await readStream(engine, tmp, stream, `back_${stream}`);
    const back = await fingerprint(engine, `back_${stream}`, stream);
    await engine.con.run(`DROP TABLE back_${stream}`);
    if (back.rows !== input.rows || back.fingerprint !== input.fingerprint) {
      throw new Error(
        `${stream}: read-back mismatch: wrote ${input.rows} rows (${input.fingerprint}), file holds ${back.rows} (${back.fingerprint})`,
      );
    }
    const foot = await readFooter(engine, tmp);
    const footErr = Object.keys(meta).find((k) => foot[k] !== meta[k]);
    if (footErr) throw new Error(`${stream}: footer ${footErr} read back as ${foot[footErr]}, wrote ${meta[footErr]}`);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  await engine.con.run(`DROP TABLE ${inputTable}`);
  return {
    file: path.basename(file),
    rows: input.rows,
    fingerprint: input.fingerprint,
    sha256: await sha256File(file),
    bytes: statSync(file).size,
  };
}

export interface TakeFile {
  format: string;
  instrument: string;
  symbol: string;
  contract: string;
  session: string;
  take: number;
  cut: { from: number; to: number };
  tickSize: string;
  tickSizeFrom: "manifest" | "registry";
  wholeBy: "manifest" | "rows";
  source: { kind: string; manifest: FetchManifest };
  streams: Partial<Record<StreamName, WrittenStream>>;
  writer: { version: string; engine: string; nodeApi: string };
  writtenAt: string;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}${TEMP_MARK}${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Writes the take in a temp directory, lets `finish` add checks.json, then renames it. */
export async function writeTake(
  engine: Engine,
  sessionPath: string,
  take: Omit<TakeFile, "streams" | "writer" | "writtenAt">,
  inputs: Partial<Record<StreamName, SelectedInput>>,
  finish: (tmpDir: string, take: TakeFile) => Promise<void>,
): Promise<TakeFile> {
  mkdirSync(sessionPath, { recursive: true });
  const finalDir = path.join(sessionPath, `take=${take.take}`);
  const tmpDir = `${finalDir}${TEMP_MARK}${process.pid}-${Date.now()}`;
  mkdirSync(tmpDir);
  try {
    const written: Partial<Record<StreamName, WrittenStream>> = {};
    for (const stream of STREAMS.filter((s) => inputs[s] !== undefined)) {
      written[stream] = await writeStreamFile(engine, stream, inputs[stream]!.table, streamFile(tmpDir, stream), {
        instrument: take.instrument,
        symbol: take.symbol,
        session: take.session,
        take: take.take,
        tickSize: take.tickSize,
        cutFrom: take.cut.from,
        cutTo: take.cut.to,
        source: take.source.kind,
        priceBasis: take.source.manifest.priceBasis,
      });
    }
    const full: TakeFile = {
      ...take,
      streams: written,
      writer: { version: WRITER_VERSION, engine: engine.version, nodeApi: engine.nodeApiVersion },
      writtenAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(tmpDir, "take.json"), full);
    await finish(tmpDir, full);
    renameSync(tmpDir, finalDir);
    return full;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
