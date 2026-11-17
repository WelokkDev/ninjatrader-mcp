import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rows, sqlStr, type Engine } from "./engine.js";
import type { StreamName } from "./source.js";

export const FILE_TYPES: Record<string, string> = {
  dt: "BIGINT",
  dpx: "INTEGER",
  size: "UINTEGER",
  bid_off: "INTEGER",
  ask_off: "INTEGER",
};

export function fileColumns(stream: StreamName): string[] {
  return stream === "prints" ? ["dt", "dpx", "size", "bid_off", "ask_off"] : ["dt", "dpx", "size"];
}

/** The one decoder. Rebuilds into table `name`: rn (0-based), ts (100 ns since 1970 UTC), px, size,
 *  bid_off, ask_off, bid, ask (prices in ticks; stamps NULL on quotes and unstamped prints). */
export async function readStream(engine: Engine, file: string, stream: StreamName, name: string): Promise<void> {
  const offs = stream === "prints" ? "bid_off, ask_off" : "NULL::INTEGER AS bid_off, NULL::INTEGER AS ask_off";
  await engine.con.run(`
    CREATE OR REPLACE TABLE ${name} AS
    SELECT rn, ts, px, size, bid_off, ask_off, px - bid_off AS bid, px + ask_off AS ask
    FROM (
      SELECT file_row_number AS rn,
             CAST(sum(dt) OVER w AS BIGINT) AS ts,
             CAST(sum(dpx) OVER w AS BIGINT) AS px,
             size, ${offs}
      FROM read_parquet(${sqlStr(file)}, file_row_number = true, hive_partitioning = false)
      WINDOW w AS (ORDER BY file_row_number ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    )
    ORDER BY rn`);
}

/** concat_ws skips NULLs, so a NULL stamp hashes as empty text to keep its place. */
export function fingerprintSql(relation: string, stream: StreamName): string {
  const fields =
    stream === "prints"
      ? "rn, ts, px, coalesce(bid_off::VARCHAR, ''), coalesce(ask_off::VARCHAR, ''), size"
      : "rn, ts, px, size";
  return `SELECT count(*)::BIGINT AS n, coalesce(bit_xor(md5_number(concat_ws(';', ${fields}))), 0)::VARCHAR AS fp FROM ${relation}`;
}

export async function fingerprint(
  engine: Engine,
  relation: string,
  stream: StreamName,
): Promise<{ rows: number; fingerprint: string }> {
  const [r] = await rows(engine.con, fingerprintSql(relation, stream));
  return { rows: Number(r.n), fingerprint: String(r.fp) };
}

export async function readFooter(engine: Engine, file: string): Promise<Record<string, string>> {
  const kv = await rows(
    engine.con,
    `SELECT decode(key) AS k, decode(value) AS v FROM parquet_kv_metadata(${sqlStr(file)})`,
  );
  return Object.fromEntries(kv.map((r) => [String(r.k), String(r.v)]));
}

export async function fileTypes(engine: Engine, file: string): Promise<Record<string, string>> {
  const desc = await rows(engine.con, `DESCRIBE SELECT * FROM read_parquet(${sqlStr(file)}, hive_partitioning = false)`);
  return Object.fromEntries(desc.map((r) => [String(r.column_name), String(r.column_type)]));
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
