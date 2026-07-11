// Public contract types for the engine's persistence + fill-execution surface. 
// These are the neutral shapes the ledger DAO, fill simulator, 
// and backtest/live walkers read and write — nothing here encodes the strategy itself.
//
// The strategy-shaped types (the decision output, zone references with their expansion geometry, 
// the playing-field decomposition and its  scoring) live in src/private/decision/types.ts and never leak into
// this file. The one crossover: the persisted Trade row carries the engine's zone/decision payloads as 
// OPAQUE JSON (typed `unknown`); the ledger serializes whatever it is given and never introspects it.

// Trade direction.
export type TradeDirection = "long" | "short";

// Which execution surface produced a trade. 'backtest' rows carry a run_id; 'paper'/'live' rows do not (run_id is null).
export type TradeMode = "backtest" | "paper" | "live";

// Which exit-management policy resolved a trade. The backtest replays the SAME
// entry set under each requested mode so they are comparable apples-to-apples:
//   fixed        — stop+target never move (the control / conservative floor)
//   trailing     — a structure-agnostic ATR chandelier (aggressive comparator)
//   constrained  — the conservative trail (per-bar candidates precomputed by
//                  the private walker under its own rules)
export type ManagementMode = "fixed" | "trailing" | "constrained";

// How a trade left the market. Mirrors trades.exit_reason.
//   stop / target          — intra-bar touch of the stop or target
//   gap-stop / gap-target   — bar opened already through the level
//   timeout                 — forced exit after a max holding period
//   manual                  — operator-closed (paper/live only)
export type ExitReason =
  | "stop"
  | "target"
  | "gap-stop"
  | "gap-target"
  | "timeout"
  | "manual";

// One step in a decision trace. The step names and `details` payloads are private engine content; 
// this is the public envelope that trade_decisions.trace_json conforms to (private content, public schema).
export interface DecisionTraceStep {
  step: string;
  passed: boolean;
  details: Record<string, unknown>;
}

// The in-flight trade the fill simulator advances bar by bar. 
// No exit fields, those are produced by the simulator and written by the walker via the ledger's updateTradeExit.
export interface OpenTrade {
  tradeId: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  entryTs: number; // unix seconds
  stopPrice: number;
  targetPrice: number;
}

// Configuration for the TS fill simulator.
export interface FillConfig {
  // Which side wins when a single bar touches both stop and target.
  // 'stop-first' is the conservative default.
  bothTouchedRule: "stop-first" | "target-first";
  // When a bar opens already through a level, fill at the bar open.
  gapFillsAtBarOpen: boolean;
  // Force-exit after this many bars in trade. null = disabled.
  maxBarsInTrade: number | null;
}

// A persisted trade — the full trades-table row. `zoneRef` and `decisionRef` are opaque JSON payloads: 
// the engine fills them with its (private) zone-reference and decision shapes, and the DAO serializes
// them verbatim without introspection. exit_* and rMultiple are null until the trade closes.
export interface Trade {
  tradeId: string;
  runId: string | null; // null for paper/live
  mode: TradeMode;
  symbol: string;
  direction: TradeDirection;
  entryTime: number; // unix seconds
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: ExitReason | null;
  rMultiple: number | null;
  zoneRef: unknown; // serialized private ZoneRef, or null
  decisionRef: unknown; // serialized private Decision, or null
  // Which exit-management policy produced this trade (the backtest experiment
  // axis). null for legacy/paper/live rows that predate the mode.
  managementMode: ManagementMode | null;
  // Bars held until exit, and max favorable excursion in R. Populated at exit
  // (updateTradeExit); null while open.
  barsInTrade: number | null;
  mfe: number | null;
  // Ingestion provenance. null for engine-generated (backtest/paper/live) rows.
  // For imported trades: source = originating system (e.g. "ibkr-flex"),
  // externalId = the source-system's own trade identifier.
  source: string | null;
  externalId: string | null;
  createdAt: number;
}

// A backtest-run header — one row per run_backtest invocation. `config`
// is the resolved strategy-config snapshot; the DAO serializes it to
// config_json.
export interface BacktestRun {
  runId: string;
  strategyName: string;
  config: unknown;
  symbol: string;
  rangeStart: number;
  rangeEnd: number;
  gitSha: string | null;
  createdAt: number;
}

// A persisted decision — one row per evaluated bar. `trace` is
// serialized to trace_json; verdict and reason are columns so the table
// is queryable without parsing JSON.
export interface TradeDecisionRow {
  decisionId: string;
  runId: string | null;
  symbol: string;
  asOf: number; // unix seconds — the bar-close instant decided at
  verdict: "yes" | "no";
  reason: string | null;
  trace: DecisionTraceStep[];
  createdAt: number;
}
