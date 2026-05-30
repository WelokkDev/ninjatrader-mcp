import type Database from "better-sqlite3";

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol    TEXT    NOT NULL,
      timeframe TEXT    NOT NULL,
      timestamp INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      PRIMARY KEY (symbol, timeframe, timestamp)
    );

    CREATE TABLE IF NOT EXISTS draw_commands (
      id         TEXT PRIMARY KEY,
      action     TEXT    NOT NULL,
      symbol     TEXT    NOT NULL,
      proximal   REAL,
      distal     REAL,
      timeframe  TEXT,
      zone_type  TEXT,
      status     TEXT    NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_candles_symbol_timeframe
      ON candles (symbol, timeframe);

    CREATE INDEX IF NOT EXISTS idx_draw_commands_status
      ON draw_commands (status);

    CREATE TABLE IF NOT EXISTS backtest_runs (
      run_id        TEXT    PRIMARY KEY,
      strategy_name TEXT    NOT NULL,
      config_json   TEXT    NOT NULL,
      symbol        TEXT    NOT NULL,
      range_start   INTEGER NOT NULL,
      range_end     INTEGER NOT NULL,
      git_sha       TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      trade_id     TEXT    PRIMARY KEY,
      run_id       TEXT,             -- null for paper/live trades
      mode         TEXT    NOT NULL, -- 'backtest' | 'paper' | 'live'
      symbol       TEXT    NOT NULL,
      direction    TEXT    NOT NULL, -- 'long' | 'short'
      entry_time   INTEGER NOT NULL,
      entry_price  REAL    NOT NULL,
      stop_price   REAL    NOT NULL,
      target_price REAL    NOT NULL,
      exit_time    INTEGER,
      exit_price   REAL,
      exit_reason  TEXT,             -- 'stop'|'target'|'gap-stop'|'gap-target'|'timeout'|'manual'
      r_multiple   REAL,
      zone_ref     TEXT,             -- opaque JSON zone reference (engine-defined shape)
      decision_ref TEXT,             -- opaque JSON decision payload at entry
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_decisions (
      decision_id TEXT    PRIMARY KEY,
      run_id      TEXT,
      symbol      TEXT    NOT NULL,
      as_of       INTEGER NOT NULL,
      verdict     TEXT    NOT NULL, -- 'yes' | 'no'
      reason      TEXT,             -- short reason code for 'no'
      trace_json  TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      symbol        TEXT    PRIMARY KEY,
      qty           INTEGER NOT NULL,
      avg_price     REAL    NOT NULL,
      open_trade_id TEXT,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_run_id ON trades (run_id);
    CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades (mode);
    CREATE INDEX IF NOT EXISTS idx_trade_decisions_run_id
      ON trade_decisions (run_id);
  `);
}
