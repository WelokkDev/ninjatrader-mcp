#!/usr/bin/env node

// One-shot rebuild script — drops every row from the `candles` table.
// Subsequent `get_candles` calls trigger on-demand fetches that hit the
// (fixed, ETH-emitting) NT8 add-on, which re-populates the cache
// with correctly-windowed and correctly-stamped bars.

import db from "../db/connection.js";

function main(): void {
  const before = (db.prepare("SELECT COUNT(*) as n FROM candles").get() as { n: number }).n;
  const result = db.prepare("DELETE FROM candles").run();
  const after = (db.prepare("SELECT COUNT(*) as n FROM candles").get() as { n: number }).n;
  console.error(
    `[rebuild-bars] cleared candles table: ${before} rows → ${after} rows (deleted ${result.changes})`,
  );
  console.error(
    `[rebuild-bars] DB will repopulate on demand as get_candles queries trigger NT8 fetches.`,
  );
  console.error(
    `[rebuild-bars] expect a window of slow MCP queries until the cache re-warms.`,
  );
}

main();
