import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { isOutOfMemory, rows, sqlStr } from "../engine.js";
import { RefusedError, unattestedManifest, type OpenSource, type StreamName } from "../source.js";

// NT8's Historical Data export: <Instrument>.Last.txt, .Bid.txt, .Ask.txt, UTC,
// no header. Last: `yyyyMMdd HHmmss fffffff;price;bid;ask;size`.
// Bid and Ask: `yyyyMMdd HHmmss fffffff;price;;;size`.

const FILE_SUFFIX: Record<StreamName, string> = { prints: ".Last.txt", bid: ".Bid.txt", ask: ".Ask.txt" };
const TIME_RE = "[0-9]{8} [0-9]{6} [0-9]{7}";

export const openSource: OpenSource = async (folder) => {
  if (!existsSync(folder)) throw new RefusedError(`folder not found: ${folder}`);
  const lasts = readdirSync(folder).filter((f) => f.endsWith(FILE_SUFFIX.prints));
  if (lasts.length !== 1) {
    throw new RefusedError(`expected exactly one <Instrument>.Last.txt in ${folder}, found ${lasts.length}`);
  }
  const instrument = lasts[0].slice(0, -FILE_SUFFIX.prints.length);
  const fileOf = (s: StreamName) => path.join(folder, instrument + FILE_SUFFIX[s]);
  const streams: StreamName[] = (["prints", "bid", "ask"] as const).filter((s) => existsSync(fileOf(s)));
  return {
    kind: "nt8-export",
    instrument,
    priceUnit: "decimal",
    streams,
    manifest: unattestedManifest(streams),
    async load(engine, stream, table) {
      const raw = `raw_${stream}`;
      try {
        // Loaded into a table with parallel=false so rowid is the line number.
        await engine.con.run(`
          CREATE OR REPLACE TABLE ${raw} AS
          SELECT * FROM read_csv(${sqlStr(fileOf(stream))},
            delim = ';', header = false, quote = '', escape = '', auto_detect = false, parallel = false,
            columns = {'c0': 'VARCHAR', 'c1': 'VARCHAR', 'c2': 'VARCHAR', 'c3': 'VARCHAR', 'c4': 'VARCHAR'})`);
      } catch (err) {
        if (isOutOfMemory(err)) throw err;
        throw new RefusedError(`${path.basename(fileOf(stream))} does not parse: ${err instanceof Error ? err.message : err}`);
      }
      if (stream !== "prints") {
        const stamped = await rows(
          engine.con,
          `SELECT rowid + 1 AS line FROM ${raw} WHERE c2 IS NOT NULL OR c3 IS NOT NULL ORDER BY rowid LIMIT 1`,
        );
        if (stamped.length > 0) {
          throw new RefusedError(`${stream} line ${stamped[0].line}: a quote row must have empty third and fourth fields`);
        }
      }
      const bidAsk = stream === "prints" ? "c2, c3" : "NULL, NULL";
      await engine.con.run(`
        INSERT INTO ${table}
        SELECT rowid + 1,
               CASE WHEN regexp_full_match(c0, '${TIME_RE}') THEN
                 CAST(epoch(try_strptime(substr(c0, 1, 15), '%Y%m%d %H%M%S')) AS BIGINT) * 10000000
                   + TRY_CAST(substr(c0, 17, 7) AS BIGINT)
               END,
               c1, c4, ${bidAsk}
        FROM ${raw} ORDER BY rowid`);
      await engine.con.run(`DROP TABLE ${raw}`);
    },
  };
};
