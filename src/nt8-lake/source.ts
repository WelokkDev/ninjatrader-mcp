import type { Engine } from "./engine.js";

export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

export type StreamName = "prints" | "bid" | "ask";
export const STREAMS: readonly StreamName[] = ["prints", "bid", "ask"];

export const UNATTESTED = "unattested";
export type Attested<T> = T | typeof UNATTESTED;

/** Times are 100 ns since 1970 UTC, as decimal strings; null when `rows` is 0. */
export interface StreamTotals {
  rows: number;
  sizeSum: string;
  firstTs: string | null;
  lastTs: string | null;
}

export interface FetchManifest {
  instrument: Attested<string>;
  /** Exact decimal text, e.g. "0.25". */
  tickSize: Attested<string>;
  window: Attested<{ from: string; to: string }>;
  fetchedAt: Attested<string>;
  priceBasis: Attested<string>;
  origin: Attested<"provider" | "repository">;
  provider: Attested<string>;
  addonVersion: Attested<string>;
  streams: Partial<Record<StreamName, Attested<StreamTotals>>>;
}

export function unattestedManifest(streams: readonly StreamName[]): FetchManifest {
  return {
    instrument: UNATTESTED,
    tickSize: UNATTESTED,
    window: UNATTESTED,
    fetchedAt: UNATTESTED,
    priceBasis: UNATTESTED,
    origin: UNATTESTED,
    provider: UNATTESTED,
    addonVersion: UNATTESTED,
    streams: Object.fromEntries(streams.map((s) => [s, UNATTESTED])),
  };
}

/** What a source must put in `table` for each stream, in NT8's order: `line` orders the rows
 *  (unique, any gaps), `ts` is 100 ns since 1970 UTC (NULL when the source could not read it),
 *  `px`/`bid`/`ask` are exact decimal text or whole ticks per `priceUnit`, `size` is integer
 *  text. Quotes leave `bid` and `ask` NULL. */
export const STAGING_COLUMNS = "line BIGINT, ts BIGINT, px VARCHAR, size VARCHAR, bid VARCHAR, ask VARCHAR";

export interface Source {
  kind: string;
  /** NT8's instrument name, e.g. "MNQ 12-26". */
  instrument: string;
  priceUnit: "decimal" | "ticks";
  streams: readonly StreamName[];
  manifest: FetchManifest;
  load(engine: Engine, stream: StreamName, table: string): Promise<void>;
}

export type OpenSource = (folder: string) => Promise<Source>;

export interface Row {
  ts: bigint | null;
  px: string;
  size: string | number;
  bid?: string | null;
  ask?: string | null;
}

/** `line` is the array position. */
export function rowsSource(opts: {
  kind?: string;
  instrument: string;
  priceUnit?: "decimal" | "ticks";
  manifest?: FetchManifest;
  streams: Partial<Record<StreamName, Row[]>>;
}): Source {
  const streams = STREAMS.filter((s) => opts.streams[s] !== undefined);
  return {
    kind: opts.kind ?? "rows",
    instrument: opts.instrument,
    priceUnit: opts.priceUnit ?? "decimal",
    streams,
    manifest: opts.manifest ?? unattestedManifest(streams),
    async load(engine, stream, table) {
      const appender = await engine.con.createAppender(table);
      const text = (v: string | null | undefined) => (v == null ? appender.appendNull() : appender.appendVarchar(v));
      (opts.streams[stream] ?? []).forEach((r, i) => {
        appender.appendBigInt(BigInt(i + 1));
        if (r.ts === null) appender.appendNull();
        else appender.appendBigInt(r.ts);
        appender.appendVarchar(r.px);
        appender.appendVarchar(String(r.size));
        text(r.bid);
        text(r.ask);
        appender.endRow();
      });
      appender.closeSync();
    },
  };
}
