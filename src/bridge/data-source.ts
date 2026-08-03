// Data-source (NT8 data feed) identity helpers.
//
// The candle cache holds REAL market data only. NinjaTrader's built-in
// "Simulated Data Feed" fabricates synthetic random-walk prices, so any bars
// it serves must never be persisted. The C# AddOn stamps each
// candles_response / bar_close with the serving feed's name; this module is
// the one place that decides which name means "synthetic, reject". Phase 2
// extends this to a per-real-feed partition; Phase 1 only quarantines sim.

/** The exact NT8 connection name of the built-in synthetic feed. */
export const SIMULATED_DATA_FEED = "Simulated Data Feed";

/**
 * True when a bridge-reported data-source name is the Simulated Data Feed.
 * Case- and whitespace-insensitive so formatting drift can't sneak sim data
 * past the gate. Absent/empty → NOT sim, so an older AddOn that omits the
 * field caches as real rather than breaking every fill.
 */
export function isSimulatedFeed(dataSource: string | null | undefined): boolean {
  return (dataSource ?? "").trim().toLowerCase() === SIMULATED_DATA_FEED.toLowerCase();
}

/** `candles.source` for NT8-fetched bars. NULL means the same (predates the column). */
export const NATIVE_CANDLE_SOURCE = "nt8";

/**
 * True when a row's `source` marks it as externally imported (e.g. a
 * Databento batch) rather than an NT8 fetch. Imported bars are immutable to
 * the fill path — without this check, a day that fails validation gets
 * refetched from NT8 and overwritten, mixing provenance within one series.
 */
export function isImportedSource(source: string | null | undefined): boolean {
  const s = (source ?? "").trim().toLowerCase();
  return s !== "" && s !== NATIVE_CANDLE_SOURCE;
}
