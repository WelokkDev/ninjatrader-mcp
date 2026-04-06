import type { Timeframe } from "./types.js";

export const SUPPORTED_SYMBOLS = ["ES", "NQ", "YM", "RTY", "CL", "GC"] as const;

export const SUPPORTED_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "2h", "4h"];

export const AGGREGATION_MAP: Record<Timeframe, number> = {
  "15m": 1,
  "30m": 2,
  "1h": 4,
  "2h": 8,
  "4h": 16,
};
