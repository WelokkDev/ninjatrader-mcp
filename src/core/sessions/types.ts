// Sun=0..Sat=6 (matches Date.getUTCDay).
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// One contiguous session span. Times are wall-clock "HH:MM" or "HH:MM:SS"
// strings interpreted in the template's `timezone`. closeTime may also be
// "24:00" to denote the very end of the close calendar day. closeWeekday
// may equal openWeekday (same-day span like RTH) or differ (span crossing
// midnight, like CME ETH where Mon-session opens Sun 18:00 and closes
// Mon 17:00 — openWeekday=0, closeWeekday=1).
export interface SessionSpan {
  openWeekday: Weekday;
  openTime: string;
  closeWeekday: Weekday;
  closeTime: string;
}

// Optional within-session break (rare; HKEX lunch, JPX intra-day). Times
// in template's timezone, applied within each span on the close calendar
// day. Not used by any registered template today.
export interface SessionBreak {
  startTime: string;
  endTime: string;
}

export interface SessionTemplate {
  name: string;
  description?: string;
  timezone: string;
  spans: SessionSpan[];
  breaks?: SessionBreak[];
}

// One concrete materialized session-day with absolute unix-second
// boundaries. Convention from design D.6 / D.2:
//   startUnix is exclusive — the session open instant; the first
//                            in-session bar's close-stamp is > startUnix
//   endUnix   is inclusive — the close-stamp of the last in-session bar
//                            (e.g. 17:00 ET for CME ETH)
export interface SessionDay {
  label: string;
  startUnix: number;
  endUnix: number;
}

// Five strategies are documented in design B.1 for completeness. Only
// session_aligned_with_stubs is implemented today; 24/7 instruments use
// the same algorithm with a daily-UTC template, which makes its output
// equivalent to wall_clock_utc. The remaining three are accepted by the
// type but throw at the aggregator until someone wires them up.
export type AlignmentStrategy =
  | "session_aligned_with_stubs"
  | "session_aligned_drop_stubs"
  | "session_aligned_merge_stubs"
  | "wall_clock_utc"
  | "wall_clock_local";

export interface InstrumentConfig {
  session: SessionTemplate;
  alignment: AlignmentStrategy;
  timestampConvention: "close-stamped";
}
