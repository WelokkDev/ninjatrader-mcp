import { REGISTRY } from "./sessions/registry.js";
import type { Timeframe } from "./types.js";

// Single source of truth for which symbols the system supports: derived
// from the session-config registry. Adding a symbol = adding a registry entry;
export const SUPPORTED_SYMBOLS: readonly string[] = Object.keys(REGISTRY);

export const SUPPORTED_TIMEFRAMES: Timeframe[] = [
  "15s", "5m", "15m", "30m", "1h", "2h", "4h", "1d",
];

// Raw timeframes are persisted directly from NT8, not derived by
// aggregation; each flows in independently (15s is tick-derived — dense
// and slower to fetch). 15m additionally drives the aggregation chain in
// AGGREGATION_MAP below.
//
// "1d" is raw because NT8 builds it from the same trading-hours template we
// resolve session-days with: one bar per session-day. It is deliberately NOT
// derived from 15m — daily history reaches back further than the intraday
// cache does, and one request returns hundreds of bars.
export const RAW_TIMEFRAMES: ReadonlyArray<Timeframe> = ["15s", "5m", "15m", "1d"];

// The subset of raw TFs the live bar feed can stream. Daily is a
// historical-fetch-only stream: a "live" daily bar would emit once per
// session, and the heal/gap machinery is built on intraday grids.
export const LIVE_TIMEFRAMES: ReadonlyArray<Timeframe> = ["15s", "5m", "15m"];

// Multipliers applied to the 15-minute base. The aggregator short-circuits
// on raw timeframes before reading this map, so they have no entry.
export const AGGREGATION_MAP: Record<Exclude<Timeframe, "15s" | "5m" | "15m" | "1d">, number> = {
  "30m": 2,
  "1h": 4,
  "2h": 8,
  "4h": 16,
};
