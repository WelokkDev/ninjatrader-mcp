import type Database from "better-sqlite3";

// '' rather than NULL: SQLite treats NULLs in a PRIMARY KEY as distinct, so a
// NULL-keyed bar could never be replaced. The `candles` view renders it NULL.
export const UNATTESTED_CONTRACT = "";

// `front` = 1 on the rows of the contract `session_contracts` assigns to the
// day; the `candles` view serves only those.
const BARS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS bars (
      symbol      TEXT    NOT NULL,
      timeframe   TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL,
      open        REAL    NOT NULL,
      high        REAL    NOT NULL,
      low         REAL    NOT NULL,
      close       REAL    NOT NULL,
      volume      REAL    NOT NULL,
      source      TEXT,
      price_basis TEXT,
      contract    TEXT    NOT NULL DEFAULT '',
      front       INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (symbol, timeframe, timestamp, contract)
    );
`;

const CONTRACT_SERVING_SQL = `
    -- The front contract per (symbol, session-day).
    CREATE TABLE IF NOT EXISTS session_contracts (
      symbol      TEXT    NOT NULL,
      session_day TEXT    NOT NULL,
      start_unix  INTEGER NOT NULL,
      end_unix    INTEGER NOT NULL,
      contract    TEXT    NOT NULL,
      decided_by  TEXT    NOT NULL,   -- 'fetch' | 'live'
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (symbol, session_day)
    );

    -- Contract conflicts, counted per (day, kind, from, to) rather than per bar.
    CREATE TABLE IF NOT EXISTS contract_events (
      symbol        TEXT    NOT NULL,
      session_day   TEXT    NOT NULL,
      kind          TEXT    NOT NULL,   -- 'reassigned' | 'off_front' | 'unattested_hidden' | 'bound_mismatch'
      from_contract TEXT    NOT NULL,
      to_contract   TEXT    NOT NULL,
      first_ts      INTEGER NOT NULL,
      last_ts       INTEGER NOT NULL,
      count         INTEGER NOT NULL,
      detail        TEXT,
      PRIMARY KEY (symbol, session_day, kind, from_contract, to_contract)
    );

    -- What every reader queries, in the shape the old table had.
    CREATE VIEW IF NOT EXISTS candles AS
      SELECT symbol, timeframe, timestamp, open, high, low, close, volume,
             source, price_basis, NULLIF(contract, '') AS contract
        FROM bars
       WHERE front = 1;

    -- For seeds, scripts and tests; production ingest writes bars directly.
    CREATE TRIGGER IF NOT EXISTS candles_insert INSTEAD OF INSERT ON candles
    BEGIN
      INSERT OR REPLACE INTO bars
        (symbol, timeframe, timestamp, open, high, low, close, volume,
         source, price_basis, contract, front)
      VALUES (NEW.symbol, NEW.timeframe, NEW.timestamp, NEW.open, NEW.high, NEW.low,
              NEW.close, NEW.volume, NEW.source, NEW.price_basis,
              COALESCE(NEW.contract, ''),
              CASE WHEN EXISTS (
                SELECT 1 FROM session_contracts s
                 WHERE s.symbol = NEW.symbol
                   AND NEW.timestamp > s.start_unix AND NEW.timestamp <= s.end_unix
                   AND s.contract <> COALESCE(NEW.contract, '')
              ) THEN 0 ELSE 1 END);
    END;

    CREATE TRIGGER IF NOT EXISTS candles_update INSTEAD OF UPDATE ON candles
    BEGIN
      UPDATE bars
         SET timestamp = NEW.timestamp, open = NEW.open, high = NEW.high, low = NEW.low,
             close = NEW.close, volume = NEW.volume, source = NEW.source,
             price_basis = NEW.price_basis, contract = COALESCE(NEW.contract, '')
       WHERE symbol = OLD.symbol AND timeframe = OLD.timeframe
         AND timestamp = OLD.timestamp AND contract = COALESCE(OLD.contract, '')
         AND front = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS candles_delete INSTEAD OF DELETE ON candles
    BEGIN
      DELETE FROM bars
       WHERE symbol = OLD.symbol AND timeframe = OLD.timeframe
         AND timestamp = OLD.timestamp AND contract = COALESCE(OLD.contract, '')
         AND front = 1;
    END;
`;

// One imported round trip per row; (source, external_id) is the dedupe key.
const TRADES_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS trades (
      trade_id    TEXT    PRIMARY KEY,
      source      TEXT    NOT NULL,   -- adapter id, e.g. 'ninjatrader'
      external_id TEXT    NOT NULL,   -- the source's own id for the round trip
      symbol      TEXT    NOT NULL,
      direction   TEXT    NOT NULL,   -- 'long' | 'short'
      quantity    REAL,               -- largest position held; NULL only on rows that predate the column
      entry_time  INTEGER NOT NULL,   -- unix seconds
      entry_price REAL    NOT NULL,
      exit_time   INTEGER,
      exit_price  REAL,
      commission  REAL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_external_id ON trades (external_id);
`;

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT    PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  migrateCandlesTableToBars(db);
  migrateTradesToImports(db);

  db.exec(`
    ${BARS_TABLE_SQL}

    ${CONTRACT_SERVING_SQL}

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

    CREATE INDEX IF NOT EXISTS idx_draw_commands_status
      ON draw_commands (status);

    -- Session-calendar exceptions per template. 'closed' = no session that
    -- date; 'modified' = non-template close_time/open_time (wall-clock
    -- HH:MM in the template tz). Times may be NULL on 'modified' rows —
    -- declared, but no time yet from NT8.
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

    ${TRADES_TABLE_SQL}

    -- Append-only audit of every order-submission attempt — allowed, blocked,
    -- or failed. Distinct from the trades table (filled round-trips): this is
    -- the forensic record of what the write path was ASKED to do. Surrogate PK
    -- so retries with the same client_order_id each get their own row.
    CREATE TABLE IF NOT EXISTS order_submissions (
      id              INTEGER PRIMARY KEY,
      ts              INTEGER NOT NULL,   -- unix seconds
      source          TEXT    NOT NULL,   -- 'mcp' / 'mcp:<session>' / 'consumer:<n>' / ...
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
      source          TEXT    NOT NULL,   -- 'mcp' / 'mcp:<session>' / 'consumer:<n>' / ...
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

    CREATE INDEX IF NOT EXISTS idx_order_submissions_client_order_id
      ON order_submissions (client_order_id);
    CREATE INDEX IF NOT EXISTS idx_order_submissions_ts
      ON order_submissions (ts);
    CREATE INDEX IF NOT EXISTS idx_order_ops_ts
      ON order_ops (ts);
    CREATE INDEX IF NOT EXISTS idx_order_ops_client_order_id
      ON order_ops (client_order_id);
  `);

  // NULL = unknown, else 'as_traded' | 'back_adjusted'. ATOMIC ON PURPOSE:
  // backfill and the completion marker commit together, so a mid-backfill
  // crash re-attempts cleanly instead of stranding half the rows.
  //
  // A cache where an earlier blanket "stamp every NULL as_traded" already ran
  // over NT8 rows is NOT repairable here — those labels are indistinguishable
  // from legitimate ones, so it needs a manual purge and re-prefetch.
  db.transaction(() => {
    const done = db
      .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
      .get("price_basis_vendor_backfill");
    if (done) return;
    // Vendor rows only — as-traded by construction. NT8 rows stay NULL: their
    // basis depended on the merge policy at fetch time, unknowable after the
    // fact. Mirrors isImportedSource (data-source.ts).
    db.exec(
      `UPDATE bars SET price_basis = 'as_traded'
        WHERE price_basis IS NULL
          AND source IS NOT NULL
          AND LOWER(TRIM(source)) NOT IN ('', 'nt8')`,
    );
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
      "price_basis_vendor_backfill",
      Math.floor(Date.now() / 1000),
    );
  })();
  // The rollover mirror is gone; the table rides on every candles_response.
  db.transaction(() => {
    const done = db
      .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
      .get("contract_rollovers_dropped");
    if (done) return;
    db.exec("DROP TABLE IF EXISTS contract_rollovers");
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
      "contract_rollovers_dropped",
      Math.floor(Date.now() / 1000),
    );
  })();
  // Nothing ever read or wrote positions; one that someone did fill is left alone.
  db.transaction(() => {
    const done = db
      .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
      .get("positions_retired");
    if (done) return;
    if (columnsOf(db, "positions").length > 0) {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number };
      if (n === 0) {
        db.exec("DROP TABLE positions");
      } else {
        console.error(`[schema] positions: ${n} row(s) in a table nothing uses; left in place`);
      }
    }
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
      "positions_retired",
      Math.floor(Date.now() / 1000),
    );
  })();
  ensureColumn(db, "order_submissions", "oco_group", "TEXT");
}

// The table once also held a backtest engine's trades, in columns the import
// never filled. Imported rows move to the current shape; an old table holding
// anything else stays behind as trades_legacy.
function migrateTradesToImports(db: Database.Database): void {
  const isOldShape = (): boolean => columnsOf(db, "trades").includes("mode");
  if (!isOldShape()) return;

  db.transaction(() => {
    if (!isOldShape()) return;
    const old = columnsOf(db, "trades");
    const hasImports = old.includes("source") && old.includes("external_id");
    for (const index of ["idx_trades_run_id", "idx_trades_mode", "idx_trades_external_id"]) {
      db.exec(`DROP INDEX IF EXISTS ${index}`);
    }
    db.exec("ALTER TABLE trades RENAME TO trades_legacy");
    db.exec(TRADES_TABLE_SQL);
    if (hasImports) {
      db.exec(
        `INSERT INTO trades
           (trade_id, source, external_id, symbol, direction, entry_time, entry_price,
            exit_time, exit_price, created_at)
         SELECT trade_id, source, external_id, symbol, direction, entry_time, entry_price,
                exit_time, exit_price, created_at
           FROM trades_legacy
          WHERE source IS NOT NULL AND external_id IS NOT NULL`,
      );
    }
    const { n: stranded } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM trades_legacy${
          hasImports ? " WHERE source IS NULL OR external_id IS NULL" : ""
        }`,
      )
      .get() as { n: number };
    if (stranded === 0) {
      db.exec("DROP TABLE trades_legacy");
    } else {
      console.error(
        `[schema] trades: ${stranded} row(s) that are not imports stay in trades_legacy; nothing reads that table`,
      );
    }
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)",
    ).run("trades_import_only", Math.floor(Date.now() / 1000));
  }).immediate();
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function migrateCandlesTableToBars(db: Database.Database): void {
  const candlesIsTable = (): boolean =>
    (
      db.prepare("SELECT type FROM sqlite_master WHERE name = 'candles'").get() as
        | { type: string }
        | undefined
    )?.type === "table";
  if (!candlesIsTable()) return;

  // Two processes can start at once: take the write lock, re-check under it,
  // and wait out the other's copy instead of failing on the default timeout.
  const busyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
  db.pragma("busy_timeout = 120000");
  try {
    db.transaction(() => {
      if (!candlesIsTable()) return;
      // Caches from before the provenance columns existed.
      ensureColumn(db, "candles", "source", "TEXT");
      ensureColumn(db, "candles", "price_basis", "TEXT");
      ensureColumn(db, "candles", "contract", "TEXT");
      db.exec(BARS_TABLE_SQL);
      db.exec(
        `INSERT INTO bars
           (symbol, timeframe, timestamp, open, high, low, close, volume,
            source, price_basis, contract, front)
         SELECT symbol, timeframe, timestamp, open, high, low, close, volume,
                source, price_basis, COALESCE(contract, ''), 1
           FROM candles`,
      );
      db.exec("DROP TABLE candles");
      // In the drop's transaction: no reader or crash finds `candles` missing.
      db.exec(CONTRACT_SERVING_SQL);
      db.prepare(
        "INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      ).run("bars_per_contract", Math.floor(Date.now() / 1000));
    }).immediate();
  } finally {
    db.pragma(`busy_timeout = ${busyTimeout}`);
  }
}

// Idempotent ADD COLUMN. One-time work tied to a column gates on
// schema_migrations, never on this returning true.
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  if (columnsOf(db, table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
