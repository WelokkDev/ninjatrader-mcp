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
