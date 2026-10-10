// A single broker fill (per-execution), pre-pairing.
export interface RawExecution {
  externalId: string;          // broker execution id — dedupe key
  symbol: string;              // master symbol ("NQ"), normalized in-adapter
  time: number;                // unix seconds (UTC)
  price: number;
  quantity: number;            // always positive
  side: "buy" | "sell";
  commission: number | null;
  account: string | null;
}

// A normalized round-trip trade (entry+exit), after pairing.
export interface RawTrade {
  externalId: string;          // stable id for the round-trip (e.g. opening execId) — dedupe key
  source: string;              // adapter id, e.g. "ninjatrader"
  symbol: string;
  direction: "long" | "short";
  entryTime: number;           // unix s — opening fill
  entryPrice: number;          // size-weighted avg if scaled in
  exitTime: number | null;
  exitPrice: number | null;    // size-weighted avg if scaled out; null while open
  quantity: number;            // max position size during the trade
  commission: number | null;   // summed across fills
}

// The fetch-only port. Every adapter implements this.
export interface TradeSource {
  readonly id: string;
  fetchTrades(range: { from: number; to: number }): Promise<RawTrade[]>;
}
