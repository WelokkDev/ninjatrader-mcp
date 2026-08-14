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

    -- Append-only audit of every order-submission attempt — allowed, blocked,
    -- or failed. Distinct from the trades table (filled round-trips): this is
    -- the forensic record of what the write path was ASKED to do. Surrogate PK
    -- so retries with the same client_order_id each get their own row.
    CREATE TABLE IF NOT EXISTS order_submissions (
      id              INTEGER PRIMARY KEY,
      ts              INTEGER NOT NULL,   -- unix seconds
      source          TEXT    NOT NULL,   -- 'claude' | 'algo' | ...
      client_order_id TEXT    NOT NULL,   -- idempotency key (= NT8 order Name)
      account         TEXT    NOT NULL,
      symbol          TEXT    NOT NULL,
      action          TEXT    NOT NULL,   -- 'Buy' | 'Sell'
      order_type      TEXT    NOT NULL,   -- 'Market' | 'Limit' | 'Stop' | 'StopLimit'
      quantity        INTEGER NOT NULL,
      limit_price     REAL,
      stop_price      REAL,
      tif             TEXT    NOT NULL,   -- 'Day' | 'Gtc'
      decision        TEXT    NOT NULL,   -- 'submitted' | 'blocked' | 'failed'
      deny_reason     TEXT,               -- gate reason when decision='blocked'
      contract        TEXT,               -- resolved contract on submit
      order_id        TEXT,               -- NT8 order id on submit (may be null)
      state           TEXT,               -- initial NT8 order state on submit
      error           TEXT,               -- error text when decision='failed'
      reason          TEXT,               -- caller-supplied rationale
      oco_group       TEXT                -- shared id linking OCO leg rows
    );

    -- Append-only audit of every non-placement write attempt (cancel /
    -- cancel-all / flatten / change) — the order_submissions counterpart for
    -- order MANAGEMENT. client_order_id is the TARGET order; null for the
    -- instrument-wide ops (cancel-all / flatten).
    CREATE TABLE IF NOT EXISTS order_ops (
      id              INTEGER PRIMARY KEY,
      ts              INTEGER NOT NULL,   -- unix seconds
      op              TEXT    NOT NULL,   -- 'cancel'|'cancel-all'|'flatten'|'change'
      source          TEXT    NOT NULL,   -- 'claude' | 'algo' | ...
      account         TEXT    NOT NULL,
      symbol          TEXT,               -- cancel-all/flatten only
      client_order_id TEXT,               -- target order (cancel/change only)
      quantity        INTEGER,            -- change only: requested new qty
      limit_price     REAL,               -- change only
      stop_price      REAL,               -- change only
      decision        TEXT    NOT NULL,   -- 'dispatched' | 'blocked' | 'failed'
      deny_reason     TEXT,               -- gate/keystone reason when blocked
      state           TEXT,               -- post-op NT8 order state when acked
      error           TEXT,               -- error text when decision='failed'
      reason          TEXT                -- caller-supplied rationale
    );

    CREATE INDEX IF NOT EXISTS idx_trades_run_id ON trades (run_id);
    CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades (mode);
    CREATE INDEX IF NOT EXISTS idx_trade_decisions_run_id
      ON trade_decisions (run_id);
    CREATE INDEX IF NOT EXISTS idx_order_submissions_client_order_id
      ON order_submissions (client_order_id);
    CREATE INDEX IF NOT EXISTS idx_order_submissions_ts
      ON order_submissions (ts);
    CREATE INDEX IF NOT EXISTS idx_order_ops_ts
      ON order_ops (ts);
    CREATE INDEX IF NOT EXISTS idx_order_ops_client_order_id
      ON order_ops (client_order_id);
  `);

  // Idempotent forward migrations: CREATE TABLE IF NOT EXISTS won't add columns
  // to a pre-existing table. ALTER ... ADD COLUMN is non-destructive.
  // Provenance of a cached bar: NULL means NT8 (predates this column), else
  // an external importer (e.g. 'databento') — see isImportedSource.
  ensureColumn(db, "candles", "source", "TEXT");

  // Price basis of a cached bar: NULL means unknown (predates this column, and
  // cannot be classified after the fact), else 'as_traded' | 'back_adjusted'.
  if (ensureColumn(db, "candles", "price_basis", "TEXT")) {
    db.exec("UPDATE candles SET price_basis = 'as_traded' WHERE price_basis IS NULL");
  }
  ensureColumn(db, "trades", "management_mode", "TEXT");
  ensureColumn(db, "trades", "bars_in_trade", "INTEGER");
  ensureColumn(db, "trades", "mfe", "REAL");
  ensureColumn(db, "trades", "source", "TEXT");
  ensureColumn(db, "trades", "external_id", "TEXT");
  ensureColumn(db, "order_submissions", "oco_group", "TEXT");
  // Must come after ensureColumn so the column exists.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_trades_external_id ON trades (external_id)",
  );
}

// Idempotent ADD COLUMN; SQLite has no `ADD COLUMN IF NOT EXISTS`. Returns true
// only on actual creation, so callers can hang a one-time migration off that.
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  decl: string,
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}
