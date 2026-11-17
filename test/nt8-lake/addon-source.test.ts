import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_LIMIT_KEY, openEngine, rows } from "../../src/nt8-lake/engine.js";
import { runLakeCli } from "../../src/nt8-lake/fetch-job.js";
import { ingest, openSource } from "../../src/nt8-lake/ops.js";
import { RefusedError, UNATTESTED, type Row } from "../../src/nt8-lake/source.js";
import type { AddonManifest } from "../../src/nt8-lake/sources/addon.js";
import { context, cutOf, removeTmpRoots, syntheticDay, tmpRoot, ts } from "./helpers.js";

const savedLimit = process.env[MEMORY_LIMIT_KEY];
afterEach(() => {
  removeTmpRoots();
  if (savedLimit === undefined) delete process.env[MEMORY_LIMIT_KEY];
  else process.env[MEMORY_LIMIT_KEY] = savedLimit;
});

const gz = (lines: string[]) => gzipSync(lines.map((l) => `${l}\n`).join(""));

function dropFolder(parts: Record<string, string[] | Buffer>, manifest: Partial<AddonManifest> = {}): string {
  const dir = tmpRoot();
  for (const [name, body] of Object.entries(parts)) writeFileSync(path.join(dir, name), Array.isArray(body) ? gz(body) : body);
  const full: AddonManifest = {
    instrument: "MNQ 12-26",
    tickSize: "0.25",
    window: UNATTESTED,
    fetchedAt: UNATTESTED,
    priceBasis: "as_traded",
    origin: "provider",
    provider: "Rithmic",
    addonVersion: "2",
    streams: { prints: UNATTESTED },
    parts: { prints: Object.keys(parts) },
    ...manifest,
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(full));
  return dir;
}

const TS = 17_931_600_000_000_000n;
const print = (i: number, price = "30000.25") => `${TS + BigInt(i) * 10_000_000n};${price};1;30000;30000.25`;

const line = (r: Row) => [r.ts, r.px, r.size, ...(r.bid !== undefined ? [r.bid, r.ask] : [])].join(";");

function addonDay(label: string): string {
  const day = syntheticDay(label);
  const cut = cutOf(label);
  const names = { prints: `prints.${label}.txt.gz`, bid: `bid.${label}.txt.gz`, ask: `ask.${label}.txt.gz` };
  return dropFolder(
    { [names.prints]: day.prints.map(line), [names.bid]: day.bid.map(line), [names.ask]: day.ask.map(line) },
    {
      window: { from: String(ts(cut.from - 3600)), to: String(ts(cut.to + 3600)) },
      fetchedAt: String(ts(cut.to + 7200)),
      streams: { prints: UNATTESTED, bid: UNATTESTED, ask: UNATTESTED },
      parts: { prints: [names.prints], bid: [names.bid], ask: [names.ask] },
    },
  );
}

function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

describe("the addon source", () => {
  it("numbers lines on across gzip parts, so a bad row names its place in the whole stream", async () => {
    const dir = dropFolder({
      "prints.2026-10-27.txt.gz": [print(0), print(1), print(2)],
      "prints.2026-10-28.txt.gz": [print(3), print(4, "12x")],
    });
    await expect(ingest(context(tmpRoot()), await openSource("addon", dir))).rejects.toThrow('prints line 5: price "12x" is not numeric');
  });

  it("refuses a missing part, a manifest that does not parse, and a wrong field count", async () => {
    const missing = dropFolder(
      { "prints.2026-10-27.txt.gz": [print(0)] },
      { parts: { prints: ["prints.2026-10-27.txt.gz", "prints.2026-10-28.txt.gz"] } },
    );
    await expect(openSource("addon", missing)).rejects.toThrow(/prints part prints\.2026-10-28\.txt\.gz is missing/);
    const bad = dropFolder({ "prints.2026-10-27.txt.gz": [print(0)] }, { parts: { prints: ["../escape.txt.gz"] } });
    await expect(openSource("addon", bad)).rejects.toThrow(/is not an add-on manifest/);
    const short = dropFolder({ "prints.2026-10-27.txt.gz": [print(0), "1;30000;1"] });
    await expect(ingest(context(tmpRoot()), await openSource("addon", short))).rejects.toThrow(/prints\.2026-10-27\.txt\.gz does not parse/);
  });

  it("refuses a part that is not gzip, or is cut short", async () => {
    const plain = dropFolder({ "prints.2026-10-27.txt.gz": Buffer.from(`${print(0)}\n`) });
    await expect(ingest(context(tmpRoot()), await openSource("addon", plain))).rejects.toThrow(/does not parse: .*not a GZIP stream/);
    const whole = gz(Array.from({ length: 20_000 }, (_, i) => print(i)));
    const cut = dropFolder({ "prints.2026-10-27.txt.gz": whole.subarray(0, whole.length >> 1) });
    await expect(ingest(context(tmpRoot()), await openSource("addon", cut))).rejects.toThrow(/does not parse: .*end of GZIP stream/);
  });

  it("opens a manifest file by its path", async () => {
    const dir = dropFolder({ "prints.2026-10-27.txt.gz": [print(0)] });
    const source = await openSource("addon", path.join(dir, "manifest.json"));
    expect(source).toMatchObject({ kind: "addon", instrument: "MNQ 12-26", streams: ["prints"] });
  });
});

describe("staging in memory", () => {
  it("never spills: no temp directory, the memory cap, two threads", async () => {
    process.env[MEMORY_LIMIT_KEY] = "16GB";
    const engine = await openEngine();
    try {
      const [r] = await rows(
        engine.con,
        "SELECT current_setting('temp_directory') AS t, current_setting('memory_limit') AS m, current_setting('threads') AS n",
      );
      expect(r).toEqual({ t: "", m: "14.9 GiB", n: "2" });
    } finally {
      engine.close();
    }
  });

  it(`takes the cap from ${MEMORY_LIMIT_KEY}, and refuses a value DuckDB cannot read`, async () => {
    process.env[MEMORY_LIMIT_KEY] = "3GB";
    const engine = await openEngine();
    try {
      expect((await rows(engine.con, "SELECT current_setting('memory_limit') AS m"))[0].m).toBe("2.7 GiB");
    } finally {
      engine.close();
    }
    process.env[MEMORY_LIMIT_KEY] = "lots";
    await expect(openEngine()).rejects.toThrow(new RefusedError(`${MEMORY_LIMIT_KEY}="lots" is not a memory size DuckDB accepts (e.g. 24GB): `).message);
  });

  it("an ingest writes nothing outside its take folder, during or after", async () => {
    const root = tmpRoot();
    const drop = addonDay("2026-10-28");
    const dropBefore = tree(drop);
    let during: string[] = [];
    const ctx = context(root, {
      referenceBars: async () => {
        during = tree(root);
        return [];
      },
    });
    const rep = await ingest(ctx, await openSource("addon", drop));
    expect(rep.days.find((d) => d.session === "2026-10-28")).toMatchObject({ status: "stored", take: 1 });

    const session = "ticks/symbol=MNQ/contract=MNQ_12-26/session=2026-10-28";
    const tmpTake = new RegExp(`^${session}/take=1\\.tmp-\\d+-\\d+/(prints\\.parquet|bid\\.parquet|ask\\.parquet|take\\.json)$`);
    expect(during).toContain("ingest.lock");
    expect(during.filter((f) => f !== "ingest.lock" && !tmpTake.test(f))).toEqual([]);
    expect(during.filter((f) => tmpTake.test(f))).toHaveLength(4);
    expect(tree(root)).toEqual(
      ["day.json", "take=1/ask.parquet", "take=1/bid.parquet", "take=1/checks.json", "take=1/prints.parquet", "take=1/take.json"].map(
        (f) => `${session}/${f}`,
      ),
    );
    expect(tree(drop)).toEqual(dropBefore);
    expect(existsSync(path.join(process.cwd(), ".tmp"))).toBe(false);
  });

  it("refuses for memory and writes nothing when the cap is too low", async () => {
    process.env[MEMORY_LIMIT_KEY] = "24MB";
    const root = tmpRoot();
    const drop = dropFolder({ "prints.2026-10-27.txt.gz": Array.from({ length: 400_000 }, (_, i) => print(i)) });
    const err = await ingest(context(root), await openSource("addon", drop)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as Error).message).toMatch(new RegExp(`needed more than its 24MB memory limit.*raise ${MEMORY_LIMIT_KEY}`));
    expect(tree(root)).toEqual([]);
    expect(existsSync(path.join(process.cwd(), ".tmp"))).toBe(false);
  });
});

describe("runLakeCli", () => {
  function script(body: string): string {
    const dir = tmpRoot();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "lake.mjs");
    writeFileSync(file, body);
    return file;
  }

  it("reads the report, a refusal, and a crash, from a child at low priority", async () => {
    // The parent lowers the priority just after spawn, so the child waits to see it.
    const echo = script(`
      import os from "node:os";
      const low = os.constants.priority.PRIORITY_LOW;
      for (const end = Date.now() + 5000; os.getPriority() !== low && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
      console.log("noise");
      console.log(JSON.stringify({ args: process.argv.slice(2), priority: os.getPriority() }));`);
    expect(await runLakeCli(["ingest", "addon", "/x"], { script: echo })).toEqual({
      report: { args: ["ingest", "addon", "/x", "--json"], priority: os.constants.priority.PRIORITY_LOW },
    });
    const refuse = script("console.log(JSON.stringify({ refused: 'lock held' })); process.exitCode = 1;");
    expect(await runLakeCli(["ingest"], { script: refuse })).toEqual({ refused: "lock held" });
    const crash = script("throw new Error('boom');");
    expect(await runLakeCli(["ingest"], { script: crash })).toEqual({ failed: expect.stringMatching(/nt8-lake ingest exited 1: .*boom/) });
    expect(await runLakeCli(["ingest"], { script: path.join(tmpRoot(), "none.js") })).toEqual({
      failed: expect.stringMatching(/none\.js is missing: run npm run build/),
    });
  });
});
