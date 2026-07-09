// Bootstrap session-calendar entries, seeded idempotently on every
// loadCalendar. Times appear only where verified against real cached data;
// untimed `modified` entries get their close from the observed-close
// interlock (core/cache/fill.ts). NT8 sync (bridge/calendar-sync.ts)
// extends this list. Scope: cme_us_index_futures_eth only — other
// templates' calendars arrive via sync.

export interface BootstrapEntry {
  date: string; // session-day label YYYY-MM-DD
  kind: "closed" | "modified";
  closeTime?: string; // "HH:MM" wall clock in template tz
  openTime?: string;
  description: string;
}

export const BOOTSTRAP_CALENDARS: Record<string, readonly BootstrapEntry[]> = {
  cme_us_index_futures_eth: [
    // Timed — verified against real cached bars.
    { date: "2026-02-16", kind: "modified", closeTime: "13:00", description: "Presidents Day" },
    { date: "2026-04-03", kind: "modified", closeTime: "09:15", description: "Good Friday (NFP half session)" },
    // Date-certain, time-unverified — observation supplies times.
    { date: "2026-01-19", kind: "modified", description: "Martin Luther King Jr. Day" },
    { date: "2026-05-25", kind: "modified", description: "Memorial Day" },
    { date: "2026-06-19", kind: "modified", description: "Juneteenth" },
    { date: "2026-07-03", kind: "modified", description: "Independence Day (observed)" },
    { date: "2026-09-07", kind: "modified", description: "Labor Day" },
    { date: "2026-11-26", kind: "modified", description: "Thanksgiving" },
    { date: "2026-11-27", kind: "modified", description: "Day after Thanksgiving" },
    { date: "2026-12-24", kind: "modified", description: "Christmas Eve" },
    // Fully closed.
    { date: "2026-12-25", kind: "closed", description: "Christmas Day" },
    { date: "2027-01-01", kind: "closed", description: "New Year's Day" },
  ],
};
