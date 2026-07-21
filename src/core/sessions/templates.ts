import type { SessionSpan, SessionTemplate } from "./types.js";

// Shared Globex weekly ETH schedule: Sun 18:00 ET → Fri 17:00 ET, one
// span per Mon-Fri close-day; the daily 17:00–18:00 ET maintenance break
// is emergent (the gap between spans, not a declared break). Shared by
// the three ETH templates below — do not mutate.
//
// Schedule pending user verification against actual NT8 templates.
const GLOBEX_WEEKLY_SPANS: SessionSpan[] = [
  { openWeekday: 0, openTime: "18:00", closeWeekday: 1, closeTime: "17:00" }, // Mon session
  { openWeekday: 1, openTime: "18:00", closeWeekday: 2, closeTime: "17:00" }, // Tue session
  { openWeekday: 2, openTime: "18:00", closeWeekday: 3, closeTime: "17:00" }, // Wed session
  { openWeekday: 3, openTime: "18:00", closeWeekday: 4, closeTime: "17:00" }, // Thu session
  { openWeekday: 4, openTime: "18:00", closeWeekday: 5, closeTime: "17:00" }, // Fri session
];

// CME index futures Globex/ETH session.
export const CME_US_INDEX_FUTURES_ETH: SessionTemplate = {
  name: "cme_us_index_futures_eth",
  description: "CME US Index Futures ETH (Globex). Sun 18:00 → Fri 17:00 ET, daily 17–18 ET maintenance break.",
  timezone: "America/New_York",
  spans: GLOBEX_WEEKLY_SPANS,
};

// NYMEX energy futures (CL etc.) on Globex. Same schedule as index
// futures ETH per CME consolidation docs; named separately so the
// registry documents the symbol→exchange mapping rather than relying on
// the consolidation being self-evident.
export const NYMEX_ENERGY_ETH: SessionTemplate = {
  name: "nymex_energy_eth",
  description: "NYMEX energy futures on Globex. Sun 18:00 → Fri 17:00 ET, daily 17–18 ET maintenance break.",
  timezone: "America/New_York",
  spans: GLOBEX_WEEKLY_SPANS,
};

// COMEX metals futures (GC etc.) on Globex. Same schedule as index
// futures ETH per CME consolidation docs; named separately for the same
// reason as NYMEX_ENERGY_ETH.
export const COMEX_METALS_ETH: SessionTemplate = {
  name: "comex_metals_eth",
  description: "COMEX metals futures on Globex. Sun 18:00 → Fri 17:00 ET, daily 17–18 ET maintenance break.",
  timezone: "America/New_York",
  spans: GLOBEX_WEEKLY_SPANS,
};

// US equities RTH (NYSE/Nasdaq). Mon-Fri 09:30 → 16:00 ET. Defined for
// completeness / future use; not registered to any symbol today.
export const NYSE_RTH: SessionTemplate = {
  name: "nyse_rth",
  description: "NYSE / US equities RTH. Mon-Fri 09:30 → 16:00 ET.",
  timezone: "America/New_York",
  spans: [
    { openWeekday: 1, openTime: "09:30", closeWeekday: 1, closeTime: "16:00" },
    { openWeekday: 2, openTime: "09:30", closeWeekday: 2, closeTime: "16:00" },
    { openWeekday: 3, openTime: "09:30", closeWeekday: 3, closeTime: "16:00" },
    { openWeekday: 4, openTime: "09:30", closeWeekday: 4, closeTime: "16:00" },
    { openWeekday: 5, openTime: "09:30", closeWeekday: 5, closeTime: "16:00" },
  ],
};

// Continuous 24/7. Seven daily UTC spans of 00:00 → 24:00 (per
// Each calendar day in UTC is its own session-day.
export const CONTINUOUS_24_7: SessionTemplate = {
  name: "continuous_24_7",
  description: "Continuous 24/7 (crypto). Seven daily UTC spans, 00:00 → 24:00.",
  timezone: "UTC",
  spans: [
    { openWeekday: 0, openTime: "00:00", closeWeekday: 0, closeTime: "24:00" },
    { openWeekday: 1, openTime: "00:00", closeWeekday: 1, closeTime: "24:00" },
    { openWeekday: 2, openTime: "00:00", closeWeekday: 2, closeTime: "24:00" },
    { openWeekday: 3, openTime: "00:00", closeWeekday: 3, closeTime: "24:00" },
    { openWeekday: 4, openTime: "00:00", closeWeekday: 4, closeTime: "24:00" },
    { openWeekday: 5, openTime: "00:00", closeWeekday: 5, closeTime: "24:00" },
    { openWeekday: 6, openTime: "00:00", closeWeekday: 6, closeTime: "24:00" },
  ],
};
