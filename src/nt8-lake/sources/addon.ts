import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isOutOfMemory, rows, sqlStr } from "../engine.js";
import { RefusedError, STREAMS, UNATTESTED, type OpenSource, type StreamName } from "../source.js";

// The add-on's drop folder: `manifest.json`, written by the hub, and one gzip part per stream
// and NT8-local day, `<stream>.<day>.txt.gz`: UTF-8, LF, no header, `ts` in 100 ns since 1970
// UTC. Prints: `ts;price;size;bid;ask`. Bid and ask: `ts;price;size`.

export const MANIFEST_FILE = "manifest.json";
const FIELDS: Record<StreamName, number> = { prints: 5, bid: 3, ask: 3 };

export function partFileName(stream: StreamName, day: string): string {
  return `${stream}.${day}.txt.gz`;
}

const digits = z.string().regex(/^-?[0-9]+$/);
const attested = <T extends z.ZodType>(schema: T) => z.union([z.literal(UNATTESTED), schema]);
const perStream = <T extends z.ZodType>(schema: T) =>
  z.object({ prints: schema.optional(), bid: schema.optional(), ask: schema.optional() });

export const addonManifestSchema = z.object({
  instrument: z.string().min(1),
  tickSize: attested(z.string()),
  window: attested(z.object({ from: digits, to: digits })),
  fetchedAt: attested(digits),
  priceBasis: attested(z.string()),
  origin: attested(z.enum(["provider", "repository"])),
  provider: attested(z.string()),
  addonVersion: attested(z.string()),
  streams: perStream(
    attested(
      z.object({
        rows: z.number().int().nonnegative(),
        sizeSum: digits,
        firstTs: digits.nullable(),
        lastTs: digits.nullable(),
      }),
    ),
  ),
  // File names in the manifest's folder, in NT8's order.
  parts: perStream(z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))),
});
export type AddonManifest = z.infer<typeof addonManifestSchema>;

export const openSource: OpenSource = async (target) => {
  const file = target.endsWith(".json") ? target : path.join(target, MANIFEST_FILE);
  if (!existsSync(file)) throw new RefusedError(`no manifest at ${file}`);
  const dir = path.dirname(file);
  let parsed: AddonManifest;
  try {
    parsed = addonManifestSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
  } catch (err) {
    const why = err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err);
    throw new RefusedError(`${file} is not an add-on manifest: ${why}`);
  }
  const { parts, ...manifest } = parsed;
  const streams = STREAMS.filter((s) => parts[s] !== undefined);
  for (const s of streams) {
    const missing = parts[s]!.find((p) => !existsSync(path.join(dir, p)));
    if (missing) throw new RefusedError(`${s} part ${missing} is missing from ${dir}`);
  }
  return {
    kind: "addon",
    instrument: parsed.instrument,
    priceUnit: "decimal",
    streams,
    manifest,
    async load(engine, stream, table) {
      const columns = Array.from({ length: FIELDS[stream] }, (_, i) => `'c${i}': 'VARCHAR'`).join(", ");
      const stamps = stream === "prints" ? "c3, c4" : "NULL, NULL";
      let offset = 0;
      for (const part of parts[stream] ?? []) {
        try {
          // parallel=false keeps file order, so row_number() OVER () is the line number.
          await engine.con.run(`
            INSERT INTO ${table}
            SELECT ${offset} + row_number() OVER (),
                   CASE WHEN regexp_full_match(c0, '[0-9]{1,19}') THEN TRY_CAST(c0 AS BIGINT) END,
                   c1, c2, ${stamps}
            FROM read_csv(${sqlStr(path.join(dir, part))},
              delim = ';', header = false, quote = '', escape = '', auto_detect = false, parallel = false,
              compression = 'gzip', columns = {${columns}})`);
        } catch (err) {
          if (isOutOfMemory(err)) throw err;
          throw new RefusedError(`${part} does not parse: ${err instanceof Error ? err.message : err}`);
        }
        const [n] = await rows(engine.con, `SELECT count(*)::BIGINT AS n FROM ${table}`);
        offset = Number(n.n);
      }
    },
  };
};
