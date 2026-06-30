import type { Ledger } from "../db/ledger.js";
import type { RawTrade, TradeSource } from "./types.js";
import type { Trade } from "../core/decision/types.js";

function toTrade(rt: RawTrade): Trade {
  return {
    tradeId: `${rt.source}:${rt.externalId}`,
    runId: null, mode: "live", symbol: rt.symbol, direction: rt.direction,
    entryTime: rt.entryTime, entryPrice: rt.entryPrice,
    stopPrice: rt.entryPrice, targetPrice: rt.entryPrice,   // unknown for imported trades; NOT NULL placeholders
    exitTime: rt.exitTime, exitPrice: rt.exitPrice,
    exitReason: rt.exitTime === null ? null : "manual",
    rMultiple: null,                                         // no stop known; win/loss uses realizedPnl
    zoneRef: null, decisionRef: null,                       // no scoring in this layer
    managementMode: null, barsInTrade: null,
    // mfe reuses the broker realizedPnl for ingested trades. A dedicated
    // realized_pnl column (Task 6) will replace this interim mapping once the
    // schema is extended; until then mfe is the only numeric slot that accepts
    // an arbitrary broker P&L value without changing the DDL.
    mfe: rt.realizedPnl,
    createdAt: Math.floor(Date.now() / 1000),
    source: rt.source, externalId: rt.externalId,
  };
}

// Pull from a source over a range and upsert into the ledger. Idempotent
// (dedupe on externalId). Returns counts. Open trades (exitTime null) are
// skipped in v1 — only completed round-trips are ingested.
export async function ingestTrades(
  source: TradeSource, ledger: Ledger, range: { from: number; to: number },
): Promise<{ fetched: number; inserted: number }> {
  const raw = await source.fetchTrades(range);
  const closed = raw.filter((t) => t.exitTime !== null);   // v1: only ingest completed round-trips
  let inserted = 0;
  for (const rt of closed) {
    const before = ledger.getTrade(`${rt.source}:${rt.externalId}`);
    ledger.upsertTradeByExternalId(toTrade(rt));
    if (!before) inserted++;
  }
  return { fetched: raw.length, inserted };
}
