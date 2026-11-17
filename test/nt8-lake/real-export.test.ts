import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/hub/config.js";
import { cacheReferenceBars, openCache } from "../../src/nt8-lake/cache.js";
import { openEngine, rows } from "../../src/nt8-lake/engine.js";
import { ingest, openSource } from "../../src/nt8-lake/ops.js";
import { readStream } from "../../src/nt8-lake/reader.js";
import { parseTickSize, selectInput, stage, writeStreamFile } from "../../src/nt8-lake/writer.js";
import { context, tmpRoot } from "./helpers.js";

// Opt-in: NT8_LAKE_EXPORT=<folder holding MNQ 12-26.{Last,Bid,Ask}.txt exported 2026-11-10>.
const folder = process.env.NT8_LAKE_EXPORT;
const run = folder && existsSync(path.join(folder, "MNQ 12-26.Last.txt")) ? describe : describe.skip;

const WHOLE_FILE = {
  prints: { rows: 2_761_302, bytes: 3_793_009, fingerprint: "84807163959306553016055942610129397808" },
  bid: { rows: 17_888_982, bytes: 12_389_493, fingerprint: "235806029168868971517569526600473134301" },
  ask: { rows: 17_902_068, bytes: 12_372_299, fingerprint: "136138348795203169776603642089109083146" },
} as const;

run("MNQ 12-26 export of 2026-10-28", () => {
  it("writes each whole file to the brief's rows, size and fingerprint, and its prints to the brief's sides and 1s bars", async () => {
    const out = tmpRoot();
    const engine = await openEngine();
    try {
      const source = await openSource("nt8-export", folder!);
      await stage(engine, source, parseTickSize("0.25"));
      for (const stream of ["prints", "bid", "ask"] as const) {
        const started = Date.now();
        const input = await selectInput(engine, stream, null);
        const w = await writeStreamFile(engine, stream, input.table, path.join(out, `${stream}.parquet`), {
          instrument: "MNQ 12-26",
          symbol: "MNQ",
          session: "whole-file",
          take: 0,
          tickSize: "0.25",
          cutFrom: "none",
          cutTo: "none",
          source: "nt8-export",
          priceBasis: "unattested",
        });
        const want = WHOLE_FILE[stream];
        console.log(`${stream}: ${w.rows} rows, ${w.bytes} bytes (brief ${want.bytes}), ${w.fingerprint}, ${Date.now() - started} ms`);
        expect(w.rows).toBe(want.rows);
        expect(w.fingerprint).toBe(want.fingerprint);
        expect(Math.abs(w.bytes - want.bytes) / want.bytes).toBeLessThan(0.05);
      }

      await readStream(engine, path.join(out, "prints.parquet"), "prints", "p");
      const [sides] = await rows(
        engine.con,
        `SELECT count(*) FILTER (WHERE bid_off = 0 AND ask_off <> 0)::BIGINT AS at_bid,
                count(*) FILTER (WHERE ask_off = 0 AND bid_off <> 0)::BIGINT AS at_ask,
                count(*) FILTER (WHERE bid_off = 0 AND ask_off = 0)::BIGINT AS both_sides,
                sum(size)::BIGINT AS contracts
         FROM p`,
      );
      expect(sides).toEqual({ at_bid: "1383263", at_ask: "1378036", both_sides: "3", contracts: "3248171" });
      const bars = await rows(
        engine.con,
        `SELECT (ts // 10000000) + 1 AS t, arg_min(px, rn) AS o, max(px) AS h, min(px) AS l, arg_max(px, rn) AS c, sum(size)::BIGINT AS v
         FROM p GROUP BY 1 ORDER BY 1`,
      );
      expect(bars.length).toBe(80_104);
      expect(Number(bars[0].t)).toBe(1793160001);
      expect(Number(bars[bars.length - 1].t)).toBe(1793246400);

      const cache = openCache(path.join(REPO_ROOT, "data", "candles.db"));
      if (cache) {
        try {
          const ref = await cacheReferenceBars(cache)("MNQ 12-26", 1793160000, 1793246400);
          const byT = new Map(ref.map((b) => [b.timestamp, b]));
          const differ = bars.filter((b) => {
            const r = byT.get(Number(b.t));
            return !r || r.open / 0.25 !== Number(b.o) || r.high / 0.25 !== Number(b.h) || r.low / 0.25 !== Number(b.l) || r.close / 0.25 !== Number(b.c) || r.volume !== Number(b.v);
          });
          console.log(`cache: ${ref.length} as-traded 1s rows in range; ${bars.length - differ.length} of ${bars.length} lake bars equal`);
        } finally {
          cache.close();
        }
      }
    } finally {
      engine.close();
      rmSync(out, { recursive: true, force: true });
    }
  }, 600_000);

  it("stores nothing from the export alone and reports both session-days partial", async () => {
    const root = tmpRoot();
    try {
      const rep = await ingest(context(root), await openSource("nt8-export", folder!));
      console.log(`ingest wall time ${rep.wallMs} ms`);
      expect(rep.days.map((d) => [d.session, d.status, d.rows])).toEqual([
        ["2026-10-28", "partial", { prints: 2_228_945, bid: 14_676_954, ask: 14_710_777 }],
        ["2026-10-29", "partial", { prints: 532_357, bid: 3_212_028, ask: 3_191_291 }],
      ]);
      expect(existsSync(path.join(root, "ticks"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
