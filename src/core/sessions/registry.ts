import {
  CME_US_INDEX_FUTURES_ETH,
  COMEX_METALS_ETH,
  NYMEX_ENERGY_ETH,
} from "./templates.js";
import type { InstrumentConfig } from "./types.js";

// Per-instrument session config. The aggregator does not read this map —
// callers do (`bridge/ingest.ts`, `tools/get-candles.ts`, `scripts/seed.ts`,
// `scripts/test-waw.ts`) and pass the resolved config into
// aggregateCandles.
//
// Schedules for cme_us_index_futures_eth, nymex_energy_eth, and
// comex_metals_eth are pending user verification against actual NT8
// templates before the F-1 NT8-add-on PR ships.
export const REGISTRY: Record<string, InstrumentConfig> = {
  // CME index futures (and micros)
  ES:  { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
  NQ:  { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
  YM:  { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
  RTY: { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
  MES: { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
  MNQ: { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
  MYM: { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
  M2K: { session: CME_US_INDEX_FUTURES_ETH, alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },

  // NYMEX energy
  CL:  { session: NYMEX_ENERGY_ETH,         alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },

  // COMEX metals
  GC:  { session: COMEX_METALS_ETH,         alignment: "session_aligned_with_stubs", timestampConvention: "close-stamped" },
};

export function getInstrumentConfig(symbol: string): InstrumentConfig {
  const config = REGISTRY[symbol];
  if (!config) {
    throw new Error(
      `No session config for symbol "${symbol}". Add it to src/core/sessions/registry.ts.`,
    );
  }
  return config;
}
