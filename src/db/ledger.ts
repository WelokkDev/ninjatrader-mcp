import type Database from "better-sqlite3";
import defaultDb from "./connection.js";
import type {
  BacktestRun,
  ExitReason,
  Trade,
  TradeDecisionRow,
  TradeDirection,
  TradeMode,
} from "../core/decision/types.js";

// Ledger DAO. A thin, typed write/read surface over the SQLite handle from connection.ts for the four engine tables: 
// backtest_runs, trades, trade_decisions, positions (positions is TODO, so no DAO method here yet,
// its DDL ships in schema.ts now so the migration is a no-op when the live walker lands).
//
// Built as a factory: createLedger(db) prepares its statements once against the supplied handle and returns the DAO. 
// The module-level `ledger` export binds it to the app's shared connection; tests bind a
// fresh `new Database(":memory:")` (after initializeSchema) for a hermetic round-trip.
//
// JSON columns (config_json, zone_ref, decision_ref, trace_json) are opaque TEXT. 
// The DAO is the only place that serializes/parses them, and it stores the structured TS shapes verbatim (camelCase).
// there is no snake_case translation layer on the JSON payloads themselves.

interface TradeRow {
  trade_id: string;
  run_id: string | null;
  mode: string;
  symbol: string;
  direction: string;
  entry_time: number;
  entry_price: number;
  stop_price: number;
  target_price: number;
  exit_time: number | null;
  exit_price: number | null;
  exit_reason: string | null;
  r_multiple: number | null;
  zone_ref: string | null;
  decision_ref: string | null;
  created_at: number;
}

interface DecisionRow {
  decision_id: string;
  run_id: string | null;
  symbol: string;
  as_of: number;
  verdict: string;
  reason: string | null;
  trace_json: string;
  created_at: number;
}

function rowToTrade(r: TradeRow): Trade {
  return {
    tradeId: r.trade_id,
    runId: r.run_id,
    mode: r.mode as TradeMode,
    symbol: r.symbol,
    direction: r.direction as TradeDirection,
    entryTime: r.entry_time,
    entryPrice: r.entry_price,
    stopPrice: r.stop_price,
    targetPrice: r.target_price,
    exitTime: r.exit_time,
    exitPrice: r.exit_price,
    exitReason: (r.exit_reason as ExitReason | null) ?? null,
    rMultiple: r.r_multiple,
    // Opaque payloads: the rich ZoneRef / Decision shapes are private.
    // The ledger round-trips them as JSON without introspection.
    zoneRef: r.zone_ref ? JSON.parse(r.zone_ref) : null,
    decisionRef: r.decision_ref ? JSON.parse(r.decision_ref) : null,
    createdAt: r.created_at,
  };
}

function rowToDecision(r: DecisionRow): TradeDecisionRow {
  return {
    decisionId: r.decision_id,
    runId: r.run_id,
    symbol: r.symbol,
    asOf: r.as_of,
    verdict: r.verdict as "yes" | "no",
    reason: r.reason,
    trace: JSON.parse(r.trace_json) as TradeDecisionRow["trace"],
    createdAt: r.created_at,
  };
}

// Realized R-multiple in units of initial risk (entry-to-stop distance). 
// Since the walker sets stop_price from the *expanded* distal, 
// this number is automatically computed off distalExpanded, not distalOriginal
// For a degenerate stop == entry, risk is 0 and we return null rather than dividing.
function computeRMultiple(
  direction: TradeDirection,
  entryPrice: number,
  stopPrice: number,
  exitPrice: number,
): number | null {
  const risk = Math.abs(entryPrice - stopPrice);
  if (risk === 0) return null;
  const pnl =
    direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return pnl / risk;
}

export interface Ledger {
  insertBacktestRun(run: BacktestRun): void;
  insertTrade(trade: Trade): void;
  updateTradeExit(
    tradeId: string,
    exit: { exitTime: number; exitPrice: number; exitReason: ExitReason },
  ): Trade;
  insertDecision(row: TradeDecisionRow): void;
  getTrade(tradeId: string): Trade | undefined;
  listTrades(filter?: { runId?: string; mode?: TradeMode }): Trade[];
  listDecisions(filter?: {
    runId?: string;
    verdict?: "yes" | "no";
  }): TradeDecisionRow[];
}

export function createLedger(db: Database.Database): Ledger {
  const insertRunStmt = db.prepare(
    `INSERT INTO backtest_runs
       (run_id, strategy_name, config_json, symbol, range_start, range_end, git_sha, created_at)
     VALUES (@run_id, @strategy_name, @config_json, @symbol, @range_start, @range_end, @git_sha, @created_at)`,
  );

  const insertTradeStmt = db.prepare(
    `INSERT INTO trades
       (trade_id, run_id, mode, symbol, direction, entry_time, entry_price,
        stop_price, target_price, exit_time, exit_price, exit_reason,
        r_multiple, zone_ref, decision_ref, created_at)
     VALUES (@trade_id, @run_id, @mode, @symbol, @direction, @entry_time, @entry_price,
        @stop_price, @target_price, @exit_time, @exit_price, @exit_reason,
        @r_multiple, @zone_ref, @decision_ref, @created_at)`,
  );

  const updateExitStmt = db.prepare(
    `UPDATE trades
        SET exit_time = @exit_time,
            exit_price = @exit_price,
            exit_reason = @exit_reason,
            r_multiple = @r_multiple
      WHERE trade_id = @trade_id`,
  );

  const insertDecisionStmt = db.prepare(
    `INSERT INTO trade_decisions
       (decision_id, run_id, symbol, as_of, verdict, reason, trace_json, created_at)
     VALUES (@decision_id, @run_id, @symbol, @as_of, @verdict, @reason, @trace_json, @created_at)`,
  );

  const getTradeStmt = db.prepare(`SELECT * FROM trades WHERE trade_id = ?`);

  return {
    insertBacktestRun(run: BacktestRun): void {
      insertRunStmt.run({
        run_id: run.runId,
        strategy_name: run.strategyName,
        config_json: JSON.stringify(run.config ?? null),
        symbol: run.symbol,
        range_start: run.rangeStart,
        range_end: run.rangeEnd,
        git_sha: run.gitSha,
        created_at: run.createdAt,
      });
    },

    insertTrade(trade: Trade): void {
      insertTradeStmt.run({
        trade_id: trade.tradeId,
        run_id: trade.runId,
        mode: trade.mode,
        symbol: trade.symbol,
        direction: trade.direction,
        entry_time: trade.entryTime,
        entry_price: trade.entryPrice,
        stop_price: trade.stopPrice,
        target_price: trade.targetPrice,
        exit_time: trade.exitTime,
        exit_price: trade.exitPrice,
        exit_reason: trade.exitReason,
        r_multiple: trade.rMultiple,
        zone_ref: trade.zoneRef ? JSON.stringify(trade.zoneRef) : null,
        decision_ref: trade.decisionRef
          ? JSON.stringify(trade.decisionRef)
          : null,
        created_at: trade.createdAt,
      });
    },

    updateTradeExit(
      tradeId: string,
      exit: { exitTime: number; exitPrice: number; exitReason: ExitReason },
    ): Trade {
      const existing = getTradeStmt.get(tradeId) as TradeRow | undefined;
      if (!existing) {
        throw new Error(`updateTradeExit: no trade with id "${tradeId}"`);
      }
      const rMultiple = computeRMultiple(
        existing.direction as TradeDirection,
        existing.entry_price,
        existing.stop_price,
        exit.exitPrice,
      );
      updateExitStmt.run({
        trade_id: tradeId,
        exit_time: exit.exitTime,
        exit_price: exit.exitPrice,
        exit_reason: exit.exitReason,
        r_multiple: rMultiple,
      });
      return rowToTrade(getTradeStmt.get(tradeId) as TradeRow);
    },

    insertDecision(row: TradeDecisionRow): void {
      insertDecisionStmt.run({
        decision_id: row.decisionId,
        run_id: row.runId,
        symbol: row.symbol,
        as_of: row.asOf,
        verdict: row.verdict,
        reason: row.reason,
        trace_json: JSON.stringify(row.trace ?? []),
        created_at: row.createdAt,
      });
    },

    getTrade(tradeId: string): Trade | undefined {
      const row = getTradeStmt.get(tradeId) as TradeRow | undefined;
      return row ? rowToTrade(row) : undefined;
    },

    listTrades(filter?: { runId?: string; mode?: TradeMode }): Trade[] {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.runId !== undefined) {
        clauses.push("run_id = @run_id");
        params.run_id = filter.runId;
      }
      if (filter?.mode !== undefined) {
        clauses.push("mode = @mode");
        params.mode = filter.mode;
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const stmt = db.prepare(
        `SELECT * FROM trades${where} ORDER BY entry_time ASC`,
      );
      const rows = (clauses.length ? stmt.all(params) : stmt.all()) as TradeRow[];
      return rows.map(rowToTrade);
    },

    listDecisions(filter?: {
      runId?: string;
      verdict?: "yes" | "no";
    }): TradeDecisionRow[] {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.runId !== undefined) {
        clauses.push("run_id = @run_id");
        params.run_id = filter.runId;
      }
      if (filter?.verdict !== undefined) {
        clauses.push("verdict = @verdict");
        params.verdict = filter.verdict;
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const stmt = db.prepare(
        `SELECT * FROM trade_decisions${where} ORDER BY as_of ASC`,
      );
      const rows = (
        clauses.length ? stmt.all(params) : stmt.all()
      ) as DecisionRow[];
      return rows.map(rowToDecision);
    },
  };
}

// App-wide singleton bound to the shared candles.db connection.
export const ledger = createLedger(defaultDb);
