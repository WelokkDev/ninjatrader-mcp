import type { Candle } from "./types.js";

export type CandleDirection = "bullish" | "bearish" | "doji";

// Classifies a candle by body direction. Pure OHLC math, no dependencies
// on strategy or zone context — intended to be reused anywhere a body
// direction is needed.
export function getCandleDirection(candle: Candle): CandleDirection {
  if (candle.close > candle.open) return "bullish";
  if (candle.close < candle.open) return "bearish";
  return "doji";
}
