import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openEngine } from "../../src/nt8-lake/engine.js";
import { identify, sessionDir, streamFile, takeDir } from "../../src/nt8-lake/layout.js";
import { ingest, verify } from "../../src/nt8-lake/ops.js";
import { fingerprint, readStream } from "../../src/nt8-lake/reader.js";
import { rowsSource, unattestedManifest, type FetchManifest, type Row, type StreamName } from "../../src/nt8-lake/source.js";
import { context, cutOf, px, removeTmpRoots, tmpRoot, ts } from "./helpers.js";

// Regenerate with NT8_LAKE_WRITE_FIXTURE=1; expected rows come from the inputs, not the decoder.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const ID = identify("MNQ 12-26");
const LABEL = "2026-10-28";
afterEach(removeTmpRoots);

function inputs(): Record<StreamName, Row[]> {
  const cut = cutOf(LABEL);
  const open = ts(cut.from + 3600, 160_000);
  const s = (n: number) => open + BigInt(n) * 10_000_000n;
  return {
    prints: [
      { ts: open, px: px(120_000), size: 2, bid: px(120_000), ask: px(120_001) },
      { ts: open, px: px(120_001), size: 1, bid: px(120_000), ask: px(120_001) },
      { ts: s(1), px: px(120_001), size: 0, bid: null, ask: null },
      { ts: s(1) - 5_000_000n, px: px(119_999), size: 3, bid: px(119_999), ask: px(119_999) },
      { ts: s(2), px: px(120_002), size: 4_294_967_295, bid: px(120_001), ask: px(120_002) },
      { ts: ts(cut.to) - 1n, px: px(120_003), size: 1, bid: px(120_003), ask: null },
    ],
    bid: [
      { ts: open - 10n, px: px(120_000), size: 7 },
      { ts: s(1), px: px(119_999), size: 0 },
      { ts: s(2), px: px(120_001), size: 12 },
    ],
    ask: [
      { ts: open - 10n, px: px(120_001), size: 4 },
      { ts: s(1), px: px(119_999), size: 1 },
      { ts: s(2), px: px(120_002), size: 9 },
    ],
  };
}

function expected(rows: Record<StreamName, Row[]>) {
  const ticks = (v: string | null | undefined) => (v == null ? null : String(Math.round(Number(v) * 4)));
  return Object.fromEntries(
    Object.entries(rows).map(([s, rs]) => [
      s,
      rs.map((r, rn) => ({
        rn: String(rn),
        ts: String(r.ts),
        px: ticks(r.px),
        size: Number(r.size),
        bid: s === "prints" ? ticks(r.bid) : null,
        ask: s === "prints" ? ticks(r.ask) : null,
      })),
    ]),
  );
}

describe("committed fixture take", () => {
  it.runIf(process.env.NT8_LAKE_WRITE_FIXTURE)("regenerates", async () => {
    const root = tmpRoot();
    const rows = inputs();
    const cut = cutOf(LABEL);
    const manifest: FetchManifest = {
      ...unattestedManifest(["prints", "bid", "ask"]),
      instrument: "MNQ 12-26",
      tickSize: "0.25",
      window: { from: String(ts(cut.from)), to: String(ts(cut.to)) },
      fetchedAt: String(ts(cut.to + 3600)),
      provider: "made-up",
    };
    await ingest(context(root), rowsSource({ kind: "fixture", instrument: "MNQ 12-26", manifest, streams: rows }));
    rmSync(FIXTURES, { recursive: true, force: true });
    cpSync(path.join(root, "ticks"), path.join(FIXTURES, "ticks"), { recursive: true });
    writeFileSync(path.join(FIXTURES, "expected.json"), JSON.stringify(expected(rows), null, 2) + "\n");
  });

  it("decodes to the rows it was written from", async () => {
    const want = JSON.parse(readFileSync(path.join(FIXTURES, "expected.json"), "utf-8"));
    expect(want).toEqual(expected(inputs()));
    const dir = takeDir(FIXTURES, ID, LABEL, 1);
    const take = JSON.parse(readFileSync(path.join(dir, "take.json"), "utf-8"));
    const engine = await openEngine();
    try {
      for (const s of ["prints", "bid", "ask"] as const) {
        await readStream(engine, streamFile(dir, s), s, "r");
        const got = (await engine.con.runAndReadAll("SELECT rn, ts, px, size, bid, ask FROM r ORDER BY rn")).getRowObjectsJson();
        expect(got).toEqual(want[s]);
        expect(await fingerprint(engine, "r", s)).toEqual({ rows: take.streams[s].rows, fingerprint: take.streams[s].fingerprint });
      }
    } finally {
      engine.close();
    }
  });

  it("verifies", async () => {
    const root = tmpRoot();
    cpSync(path.join(FIXTURES, "ticks"), path.join(root, "ticks"), { recursive: true });
    expect(existsSync(sessionDir(root, ID, LABEL))).toBe(true);
    const rep = await verify(context(root));
    expect(rep.takes.map((t) => t.problems)).toEqual([[]]);
    expect(rep.ok).toBe(true);
  });
});
