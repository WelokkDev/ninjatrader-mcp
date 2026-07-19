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

    -- Session-calendar exceptions per template. 'closed' = no session that
    -- date; 'modified' = non-template close_time/open_time (wall-clock
    -- HH:MM in the template tz). Times may be NULL on 'modified' rows —
    -- declared but not yet observed from a real fetch.
    CREATE TABLE IF NOT EXISTS session_calendar (
      template    TEXT NOT NULL,
      date        TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('closed','modified')),
      close_time  TEXT,
      open_time   TEXT,
      source      TEXT NOT NULL,
      description TEXT,
      PRIMARY KEY (template, date)
    );

    -- Operator-desired live subscriptions (consumer interests are ephemeral).
    -- Replayed to the AddOn on startup and every hello.
    CREATE TABLE IF NOT EXISTS live_subscriptions (
      symbol     TEXT NOT NULL,
      timeframe  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, timeframe)
    );

    -- Operator-desired live position feed (account-wide, single toggle).
    -- Enforced on the AddOn on startup and every hello.
    CREATE TABLE IF NOT EXISTS live_position_feed (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      enabled    INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

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
      management_mode TEXT,          -- 'fixed'|'trailing'|'constrained' (backtest exit policy); null for legacy/live
      bars_in_trade   INTEGER,       -- bars held until exit; null while open
      mfe             REAL,          -- max favorable excursion in R; null while open
      source          TEXT,          -- adapter id for imported trades (e.g. 'ninjatrader'); null for engine trades
      external_id     TEXT,          -- broker round-trip/exec id; dedupe key for imported trades; null for engine trades
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

  // Forward migrations for columns added after a `trades` table already existed.
  // CREATE TABLE IF NOT EXISTS won't add columns to a pre-existing table, so the
  // backtest experiment's per-trade fields (management_mode / bars_in_trade /
  // mfe) are added idempotently here. Cheap and safe: the table is keyed by an
  // empty/append-only ledger and ALTER ... ADD COLUMN is non-destructive.
  ensureColumn(db, "trades", "management_mode", "TEXT");
  ensureColumn(db, "trades", "bars_in_trade", "INTEGER");
  ensureColumn(db, "trades", "mfe", "REAL");
  ensureColumn(db, "trades", "source", "TEXT");
  ensureColumn(db, "trades", "external_id", "TEXT");
  // Index for idempotent upsert lookup — must come after ensureColumn so the column exists.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_trades_external_id ON trades (external_id)",
  );
}

// Add `column` to `table` if it isn't already present (a minimal idempotent
// migration; SQLite has no `ADD COLUMN IF NOT EXISTS`).
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
