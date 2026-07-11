// Public multi-timeframe (MTF) frozen-view contract.
//
// A FrozenView is the as-of snapshot the decision engine reads at a single
// bar-close instant: the entry-TF series plus, per higher timeframe, two
// distinct cuts of history that downstream consumers must not conflate.
//
// This module is deliberately PUBLIC (no strategy content) — it only
// buckets and trims bars by an as-of timestamp. The strategy-shaped
// consumers (zone detection, SMA / trend reads in src/private) import
// this shape.

import type { Candle, Timeframe } from "../types.js";

export interface FrozenView {
  // Entry-TF bars with timestamp <= asOf.
  primary: Candle[];
  // Per HTF: bars whose bucket CLOSED at <= asOf — the only bars safe for zone detection, since a still-forming bucket can change its OHLC.
  completed: Map<Timeframe, Candle[]>;
  // Per HTF: `completed` plus a trailing forming bar (NOT flagged partial), for SMA / trend reads that want the live value at asOf rather than the last closed value.
  asOfView: Map<Timeframe, Candle[]>;
}
