import { REGISTRY } from "./sessions/registry.js";
import type { Timeframe } from "./types.js";

// Single source of truth for which symbols the system supports: derived
// from the session-config registry. Adding a symbol = adding a registry
// entry; the two cannot drift. See design E.4.
export const SUPPORTED_SYMBOLS: readonly string[] = Object.keys(REGISTRY);

export const SUPPORTED_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "2h", "4h"];

// Multipliers applied to the 15-minute base. The aggregator short-circuits
// on `targetTimeframe === "15m"` before reading this map, so 15m has no
// entry.
export const AGGREGATION_MAP: Record<Exclude<Timeframe, "15m">, number> = {
  "30m": 2,
  "1h": 4,
  "2h": 8,
  "4h": 16,
};
