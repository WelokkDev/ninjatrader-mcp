import { REGISTRY } from "./sessions/registry.js";
import type {
  DerivedTimeframe,
  LiveTimeframe,
  RawTimeframe,
  SubMinuteTimeframe,
  Timeframe,
} from "./types.js";

// Single source of truth for which symbols the system supports: derived
// from the session-config registry. Adding a symbol = adding a registry entry;
export const SUPPORTED_SYMBOLS: readonly string[] = Object.keys(REGISTRY);

export const SUPPORTED_TIMEFRAMES: Timeframe[] = [
  "1s", "5s", "15s", "5m", "15m", "30m", "1h", "2h", "4h", "1d",
];

// Persisted directly from NT8, not derived by aggregation. "1d" is raw
// rather than bucketed from 15m — daily history reaches back further than
// the intraday cache does.
export const RAW_TIMEFRAMES: ReadonlyArray<RawTimeframe> = [
  "1s", "5s", "15s", "5m", "15m", "1d",
];

// The subset of raw TFs the live bar feed can stream. Daily is a
// historical-fetch-only stream: a "live" daily bar would emit once per
// session, and the heal/gap machinery is built on intraday grids.
export const LIVE_TIMEFRAMES: ReadonlyArray<LiveTimeframe> = [
  "1s", "5s", "15s", "5m", "15m",
];

// Keep in sync by hand with SPARSE_TOLERANCE in core/cache/validator.ts.
export const SUB_MINUTE_TIMEFRAMES: ReadonlyArray<SubMinuteTimeframe> = ["1s", "5s", "15s"];

// `ReadonlyArray.includes` isn't a type guard; these narrow without a cast.
export function isRawTimeframe(tf: Timeframe): tf is RawTimeframe {
  return (RAW_TIMEFRAMES as ReadonlyArray<Timeframe>).includes(tf);
}

export function isLiveTimeframe(tf: Timeframe): tf is LiveTimeframe {
  return (LIVE_TIMEFRAMES as ReadonlyArray<Timeframe>).includes(tf);
}

export function isSubMinuteTimeframe(tf: Timeframe): tf is SubMinuteTimeframe {
  return (SUB_MINUTE_TIMEFRAMES as ReadonlyArray<Timeframe>).includes(tf);
}

// Multipliers applied to the 15-minute base. The aggregator short-circuits
// on raw timeframes before reading this map, so they have no entry.
export const AGGREGATION_MAP: Record<DerivedTimeframe, number> = {
  "30m": 2,
  "1h": 4,
  "2h": 8,
  "4h": 16,
};
