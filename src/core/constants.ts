import { REGISTRY } from "./sessions/registry.js";
import type { Timeframe } from "./types.js";

// Single source of truth for which symbols the system supports: derived
// from the session-config registry. Adding a symbol = adding a registry entry;
export const SUPPORTED_SYMBOLS: readonly string[] = Object.keys(REGISTRY);

export const SUPPORTED_TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "2h", "4h"];

// Raw timeframes are persisted directly from NT8; they are not derived
// by aggregation. 5m and 15m each flow in independently from the bridge.
// 15m additionally drives the aggregation chain in AGGREGATION_MAP below.
export const RAW_TIMEFRAMES: ReadonlyArray<Timeframe> = ["5m", "15m"];

// Multipliers applied to the 15-minute base. The aggregator short-circuits
// on raw timeframes before reading this map, so 5m and 15m have no entry.
export const AGGREGATION_MAP: Record<Exclude<Timeframe, "5m" | "15m" | "1d">, number> = {
  "30m": 2,
  "1h": 4,
  "2h": 8,
  "4h": 16,
};
