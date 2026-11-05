import type { Ledger, Trade } from "../db/ledger.js";
import type { RawTrade, TradeSource } from "./types.js";

function toTrade(rt: RawTrade): Trade {
  return {
    tradeId: `${rt.source}:${rt.externalId}`,
    source: rt.source, externalId: rt.externalId,
    symbol: rt.symbol, direction: rt.direction,
    quantity: rt.quantity, filledQuantity: rt.filledQuantity,
    entryTime: rt.entryTime, entryPrice: rt.entryPrice,
    exitTime: rt.exitTime, exitPrice: rt.exitPrice,
    commission: rt.commission, account: rt.account,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export async function ingestTrades(
  source: TradeSource, ledger: Ledger, range: { from: number; to: number },
): Promise<{ fetched: number; inserted: number; filled: number; mismatched: number }> {
  const raw = await source.fetchTrades(range);
  const closed = raw.filter((t) => t.exitTime !== null);   // v1: only ingest completed round-trips
  let inserted = 0;
  let filled = 0;
  let mismatched = 0;
  for (const rt of closed) {
    const outcome = ledger.importTrade(toTrade(rt));
    if (outcome === "inserted") inserted++;
    else if (outcome === "filled") filled++;
    else if (outcome === "mismatched") mismatched++;
  }
  return { fetched: raw.length, inserted, filled, mismatched };
}
