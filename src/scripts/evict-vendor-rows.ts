// Remove externally-imported (vendor) bars from the NT8 candle cache.
//
// The cache is the NT8 store; vendor history belongs in the bar lake. One row
// of each in one table is the mixed series the two-store rule exists to
// prevent: the two roll on different dates, so a range crossing a roll holds
// different contracts depending on which rows answered. Rows carrying an
// importer marker in `candles.source` are residue from before that rule.
//
// DESTRUCTIVE. Dry-run is the default and `--confirm` is required to delete.
// Run it only AFTER the same range is in the lake and verified there: this
// script cannot see the lake (that store is Python-side), so it cannot check
// recoverability for you.
//
//   node build/scripts/evict-vendor-rows.js                     # report only
//   node build/scripts/evict-vendor-rows.js --confirm           # delete + VACUUM
//   node build/scripts/evict-vendor-rows.js --confirm --expect 22116858
//
// `--expect` refuses unless the count it is about to delete matches exactly,
// so a command copied from an earlier session cannot quietly remove more than
// it was written for.

import db from "../db/connection.js";
import { isImportedSource } from "../bridge/data-source.js";

interface SourceRow {
  source: string | null;
  n: number;
  oldest: number;
  newest: number;
  symbols: string;
}

function iso(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function survey(): SourceRow[] {
  return db
    .prepare(
      `SELECT source,
              COUNT(*)        AS n,
              MIN(timestamp)  AS oldest,
              MAX(timestamp)  AS newest,
              GROUP_CONCAT(DISTINCT symbol || ' ' || timeframe) AS symbols
         FROM candles
        GROUP BY source
        ORDER BY n DESC`,
    )
    .all() as SourceRow[];
}

function main(): number {
  const argv = process.argv.slice(2);
  const confirm = argv.includes("--confirm");
  const expectIdx = argv.indexOf("--expect");
  const expect = expectIdx >= 0 ? Number(argv[expectIdx + 1]) : null;
  if (expectIdx >= 0 && !Number.isInteger(expect)) {
    console.error("--expect needs an integer row count");
    return 1;
  }

  const rows = survey();
  const vendor = rows.filter((r) => isImportedSource(r.source));
  const native = rows.filter((r) => !isImportedSource(r.source));

  console.log("candles.source breakdown\n");
  for (const r of [...vendor, ...native]) {
    const tag = isImportedSource(r.source) ? "VENDOR " : "keep   ";
    const label = r.source ?? "<null = NT8>";
    console.log(
      `  ${tag} ${label.padEnd(24)} ${r.n.toLocaleString().padStart(12)} rows  ` +
        `${iso(r.oldest)} -> ${iso(r.newest)}  [${r.symbols}]`,
    );
  }

  const total = vendor.reduce((sum, r) => sum + r.n, 0);
  const keep = native.reduce((sum, r) => sum + r.n, 0);
  console.log(
    `\n  vendor rows to evict: ${total.toLocaleString()}` +
      `\n  NT8 rows to keep:     ${keep.toLocaleString()}`,
  );

  if (total === 0) {
    console.log("\nNothing to evict — the cache already holds NT8 rows only.");
    return 0;
  }
  if (expect !== null && expect !== total) {
    console.error(
      `\nREFUSING: --expect ${expect.toLocaleString()} but found ${total.toLocaleString()}. ` +
        "The cache changed since that number was taken — re-survey before deleting.",
    );
    return 1;
  }
  if (!confirm) {
    console.log(
      "\nDry run. Re-run with --confirm to delete (and ideally --expect " +
        `${total} to pin the count).\n` +
        "Verify the lake holds this range FIRST — nothing here can check that for you.",
    );
    return 0;
  }

  // One transaction: a half-evicted cache is a mixed store with nothing
  // marking it as one, which is worse than either end state.
  const markers = vendor.map((r) => r.source).filter((s): s is string => s !== null);
  const placeholders = markers.map(() => "?").join(", ");
  const deleted = db.transaction(() => {
    const info = db
      .prepare(`DELETE FROM candles WHERE source IN (${placeholders})`)
      .run(...markers);
    return info.changes;
  })();
  console.log(`\nDeleted ${deleted.toLocaleString()} row(s). Reclaiming space...`);
  // Outside the transaction — VACUUM cannot run inside one, and it needs an
  // exclusive lock a running MCP server denies. That is a disk-space problem,
  // not a correctness one, so it must not read as a failed eviction.
  try {
    db.exec("VACUUM");
    console.log("Reclaimed.");
  } catch (e) {
    console.warn(
      `VACUUM skipped (${e instanceof Error ? e.message : String(e)}). The rows ARE ` +
        "deleted; the file keeps its old size until a VACUUM runs with no other " +
        "process holding the database. Stop the MCP server and re-run to reclaim.",
    );
  }
  const after = survey().reduce((sum, r) => sum + r.n, 0);
  console.log(`Done. candles now holds ${after.toLocaleString()} row(s), all NT8.`);
  return 0;
}

process.exit(main());
