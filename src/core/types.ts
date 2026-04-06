export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "15m" | "30m" | "1h" | "2h" | "4h";

export type ZoneType = "supply" | "demand";

export type FormationType = "RBD" | "DBR" | "DBD" | "RBR";

export interface Zone {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  type: ZoneType;
  formation: FormationType;
  proximal: number;
  distal: number;
  timestamp: number;
  waw_count: number;
  score: number | null;
}

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
