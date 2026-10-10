import type { Ledger, Trade } from "../db/ledger.js";
import type { RawTrade, TradeSource } from "./types.js";

function toTrade(rt: RawTrade): Trade {
  return {
    tradeId: `${rt.source}:${rt.externalId}`,
    source: rt.source, externalId: rt.externalId,
    symbol: rt.symbol, direction: rt.direction, quantity: rt.quantity,
    entryTime: rt.entryTime, entryPrice: rt.entryPrice,
    exitTime: rt.exitTime, exitPrice: rt.exitPrice,
    commission: rt.commission,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

// Pull from a source over a range and insert-if-absent into the ledger. Idempotent (dedupe on (source, externalId)).
// Returns counts. Open trades (exitTime null) are skipped in v1 — only completed round-trips are ingested.
export async function ingestTrades(
  source: TradeSource, ledger: Ledger, range: { from: number; to: number },
): Promise<{ fetched: number; inserted: number }> {
  const raw = await source.fetchTrades(range);
  const closed = raw.filter((t) => t.exitTime !== null);   // v1: only ingest completed round-trips
  let inserted = 0;
  for (const rt of closed) {
    const before = ledger.getTrade(`${rt.source}:${rt.externalId}`);
    ledger.insertTradeIfAbsent(toTrade(rt));
    if (!before) inserted++;
  }
  return { fetched: raw.length, inserted };
}
