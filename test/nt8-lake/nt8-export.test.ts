import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identify, streamFile, takeDir } from "../../src/nt8-lake/layout.js";
import { ingest, openSource } from "../../src/nt8-lake/ops.js";
import { openEngine } from "../../src/nt8-lake/engine.js";
import { readStream } from "../../src/nt8-lake/reader.js";
import { context, cutOf, removeTmpRoots, syntheticDay, tmpRoot, type Streams } from "./helpers.js";
import type { Row } from "../../src/nt8-lake/source.js";

const ID = identify("MNQ 12-26");
afterEach(removeTmpRoots);

function stamp(t: bigint): string {
  const sec = Number(t / 10_000_000n);
  const d = new Date(sec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${date} ${time} ${p(Number(t % 10_000_000n), 7)}`;
}

function exportFolder(day: Partial<Streams>, eol = "\r\n"): string {
  const dir = path.join(tmpRoot(), "export");
  mkdirSync(dir);
  const line = (r: Row, quote: boolean) =>
    quote ? `${stamp(r.ts!)};${r.px};;;${r.size}` : `${stamp(r.ts!)};${r.px};${r.bid ?? ""};${r.ask ?? ""};${r.size}`;
  const write = (suffix: string, rows: Row[] | undefined, quote: boolean) => {
    if (rows) writeFileSync(path.join(dir, `MNQ 12-26.${suffix}.txt`), rows.map((r) => line(r, quote) + eol).join(""));
  };
  write("Last", day.prints, false);
  write("Bid", day.bid, true);
  write("Ask", day.ask, true);
  return dir;
}

describe("nt8-export source", () => {
  for (const [name, eol] of [["CRLF", "\r\n"], ["LF", "\n"]]) {
    it(`reads a ${name} export into the same take as the rows`, async () => {
      const day = syntheticDay("2026-10-28");
      const fromText = tmpRoot();
      const fromRows = tmpRoot();
      const viaText = await ingest(context(fromText), await openSource("nt8-export", exportFolder(day, eol)));
      const { rowsSource } = await import("../../src/nt8-lake/source.js");
      const viaRows = await ingest(context(fromRows), rowsSource({ instrument: "MNQ 12-26", streams: day }));
      expect(viaText.source).toBe("nt8-export");
      expect(viaText.days.map((d) => [d.session, d.status, d.rows])).toEqual(viaRows.days.map((d) => [d.session, d.status, d.rows]));
      const engine = await openEngine();
      try {
        for (const r of [fromText, fromRows]) {
          await readStream(engine, streamFile(takeDir(r, ID, "2026-10-28", 1), "prints"), "prints", r === fromText ? "a" : "b");
        }
        const diff = await engine.con.runAndReadAll("SELECT count(*) AS n FROM (SELECT * FROM a EXCEPT ALL SELECT * FROM b)");
        expect(Number(diff.getRowObjectsJson()[0].n)).toBe(0);
      } finally {
        engine.close();
      }
    });
  }

  it("refuses a line with the wrong number of fields", async () => {
    const dir = exportFolder(syntheticDay("2026-10-28"));
    writeFileSync(path.join(dir, "MNQ 12-26.Last.txt"), "20261028 040000 0160000;29935.25;29935.25;2\r\n");
    const r = tmpRoot();
    await expect(ingest(context(r), await openSource("nt8-export", dir))).rejects.toThrow(/MNQ 12-26.Last.txt does not parse/);
    expect(existsSync(path.join(r, "ticks"))).toBe(false);
  });

  it("refuses a bad time with its line number", async () => {
    const day = syntheticDay("2026-10-28");
    const dir = exportFolder(day);
    const lines = day.prints.map((p) => `${stamp(p.ts!)};${p.px};${p.bid};${p.ask};${p.size}`);
    lines[4] = lines[4].replace(/^\d{8}/, "20261399");
    writeFileSync(path.join(dir, "MNQ 12-26.Last.txt"), lines.join("\n") + "\n");
    await expect(ingest(context(tmpRoot()), await openSource("nt8-export", dir))).rejects.toThrow(/prints line 5: time does not parse/);
  });

  it("refuses a quote row with stamp fields", async () => {
    const day = syntheticDay("2026-10-28");
    const dir = exportFolder(day);
    writeFileSync(path.join(dir, "MNQ 12-26.Bid.txt"), `${stamp(day.bid[0].ts!)};${day.bid[0].px};1;;5\n`);
    await expect(ingest(context(tmpRoot()), await openSource("nt8-export", dir))).rejects.toThrow(/bid line 1: a quote row must have empty/);
  });

  it("stores nothing from a folder holding only part of each session-day", async () => {
    const day = syntheticDay("2026-10-28");
    const cut = cutOf("2026-10-28");
    const mid = (rows: Row[]) => rows.filter((r) => r.ts! >= BigInt(cut.from) * 10_000_000n);
    const r = tmpRoot();
    const rep = await ingest(context(r), await openSource("nt8-export", exportFolder({ prints: mid(day.prints), bid: mid(day.bid), ask: mid(day.ask) })));
    expect(rep.days.map((d) => [d.session, d.status])).toEqual([
      ["2026-10-28", "partial"],
      ["2026-10-29", "partial"],
    ]);
    expect(existsSync(path.join(r, "ticks"))).toBe(false);
  });
});

describe("source names", () => {
  it("refuses an unknown source", async () => {
    await expect(openSource("live-capture", tmpRoot())).rejects.toThrow(/unknown source "live-capture"/);
    await expect(openSource("../x", tmpRoot())).rejects.toThrow(/bad source name/);
  });
});
