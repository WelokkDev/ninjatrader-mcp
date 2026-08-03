export interface Candle {
  // Unix seconds. Close-stamped per NT8 convention: `timestamp` is the
  // close of the bar, not the open. For a 15-minute bar covering
  // 18:00:00–18:14:59 ET, NT8's `Bars.GetTime(i)` returns 18:15:00 ET, and
  // we store that verbatim.
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  // Set true on the most-recent aggregated bar when its session-day's
  // expected end is in the future — i.e., more underlying bars may still
  // arrive that extend or supersede this bucket. Consumers that ignore
  // the field see no behavior change. Zone detection should skip
  // partial bars (follow-up — not enforced today).
  partial?: boolean;
}

export type Timeframe =
  | "1s" | "5s" | "15s" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d";

// Persisted straight from NT8, not bucketed from another TF.
export type RawTimeframe = "1s" | "5s" | "15s" | "5m" | "15m" | "1d";

// "1d" excluded — no such thing as a "live" daily bar.
export type LiveTimeframe = Exclude<RawTimeframe, "1d">;

export type SubMinuteTimeframe = Extract<LiveTimeframe, "1s" | "5s" | "15s">;

// Everything bucketed from 15m by the aggregation chain.
export type DerivedTimeframe = Exclude<Timeframe, RawTimeframe>;

export type ZoneType = "supply" | "demand";

export interface Trade {
  id: string;
  symbol: string;
  zone_type: ZoneType;
  timeframe: Timeframe;
  entry: number;
  stop: number;
  target: number;
  r_multiple: number;
  outcome: "win" | "loss" | "breakeven" | "open";
  notes: string;
  created_at: number;
}

export interface DrawCommand {
  id: string;
  action: "draw" | "clear";
  symbol: string;
  proximal?: number;
  distal?: number;
  timeframe?: Timeframe;
  zone_type?: ZoneType;
  status: "pending" | "drawn" | "cleared";
}
