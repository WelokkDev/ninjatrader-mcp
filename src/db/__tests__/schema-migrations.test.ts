import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { initializeSchema } from "../schema.js";

/** The `candles` table as it existed BEFORE the price_basis migration, so the
 *  test exercises the real ALTER path rather than a freshly-created table. */
function legacyCandlesDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE candles (
      symbol    TEXT    NOT NULL,
      timeframe TEXT    NOT NULL,
      timestamp INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      source    TEXT,
      PRIMARY KEY (symbol, timeframe, timestamp)
    );
  `);
  return db;
}

function insertBar(db: Database.Database, ts: number, source: string | null): void {
  db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume, source)
     VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10, ?)`,
  ).run(ts, source);
}

function basisOf(db: Database.Database, ts: number): string | null {
  const row = db
    .prepare(`SELECT price_basis FROM candles WHERE timestamp = ?`)
    .get(ts) as { price_basis: string | null } | undefined;
  return row?.price_basis ?? null;
}

function markerPresent(db: Database.Database): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM schema_migrations WHERE name = 'price_basis_vendor_backfill'`)
      .get() !== undefined
  );
}

describe("price_basis migration", () => {
  it("backfills imported vendor rows only — NT8 rows are unknowable after the fact", () => {
    const db = legacyCandlesDb();
    insertBar(db, 1000, null); // NT8-fetched, predates the source column
    insertBar(db, 1500, "nt8"); // NT8-fetched, explicit
    insertBar(db, 2000, "databento"); // imported

    initializeSchema(db);

    const cols = (db.prepare("PRAGMA table_info(candles)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("price_basis");

    // An NT8 row's basis depended on the merge policy at fetch time.
    expect(basisOf(db, 2000)).toBe("as_traded");
    expect(basisOf(db, 1000)).toBeNull();
    expect(basisOf(db, 1500)).toBeNull();
    expect(markerPresent(db)).toBe(true);
  });

  it("does NOT backfill on a later run — the marker gates it to exactly once", () => {
    const db = legacyCandlesDb();
    insertBar(db, 2000, "databento");
    initializeSchema(db);
    expect(basisOf(db, 2000)).toBe("as_traded");

    // Later rows are the write path's job; a recurring sweep would paper over
    // a labelling bug instead of surfacing it.
    insertBar(db, 3000, null);
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume, source)
       VALUES ('NQ', '5m', 4000, 1, 2, 0.5, 1.5, 10, 'databento')`,
    ).run();

    initializeSchema(db);

    expect(basisOf(db, 3000)).toBeNull();
    expect(basisOf(db, 4000)).toBeNull();
    expect(basisOf(db, 2000)).toBe("as_traded");
  });

  it("rolls the backfill back when it fails — the marker never lands without the rows", () => {
    const db = legacyCandlesDb();
    insertBar(db, 2000, "databento");

    const realExec = db.exec.bind(db);
    let attempted = false;
    (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (sql.includes("UPDATE bars SET price_basis")) {
        attempted = true;
        throw new Error("simulated crash during backfill");
      }
      return realExec(sql);
    };

    expect(() => initializeSchema(db)).toThrow(/simulated crash/);
    expect(attempted).toBe(true);

    (db as unknown as { exec: (sql: string) => unknown }).exec = realExec;

    // Marker and rows both untouched, so the next run re-attempts everything.
    expect(basisOf(db, 2000)).toBeNull();
    expect(markerPresent(db)).toBe(false);

    // ...and a retry completes it.
    initializeSchema(db);
    expect(basisOf(db, 2000)).toBe("as_traded");
    expect(markerPresent(db)).toBe(true);
  });

  it("repairs a database stranded by the pre-marker migration", () => {
    // Column present, every row NULL: unfinished work, not work to skip.
    const db = legacyCandlesDb();
    db.exec("ALTER TABLE candles ADD COLUMN price_basis TEXT");
    insertBar(db, 1000, null); // NT8 — stays NULL
    insertBar(db, 2000, "databento"); // vendor — repairable

    initializeSchema(db);

    expect(basisOf(db, 2000)).toBe("as_traded");
    expect(basisOf(db, 1000)).toBeNull();
    expect(markerPresent(db)).toBe(true);
  });

  it("is idempotent — repeated initialization neither throws nor duplicates", () => {
    const db = legacyCandlesDb();
    initializeSchema(db);
    initializeSchema(db);
    initializeSchema(db);

    const matches = (
      db.prepare("PRAGMA table_info(candles)").all() as Array<{ name: string }>
    ).filter((c) => c.name === "price_basis");
    expect(matches).toHaveLength(1);
  });

  it("leaves a fresh database with the column and nothing to backfill", () => {
    const db = new Database(":memory:");
    initializeSchema(db);

    const cols = (db.prepare("PRAGMA table_info(candles)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("price_basis");
    expect(cols).toContain("source");
    expect(markerPresent(db)).toBe(true);
  });
});

describe("trades table", () => {
  const CURRENT_COLUMNS = [
    "trade_id", "source", "external_id", "symbol", "direction", "quantity",
    "entry_time", "entry_price", "exit_time", "exit_price", "commission", "created_at",
  ];

  /** The table as it was when it also held the backtest engine's trades. */
  function oldTradesDb(opts: { importColumns?: boolean } = {}): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE trades (
        trade_id     TEXT    PRIMARY KEY,
        run_id       TEXT,
        mode         TEXT    NOT NULL,
        symbol       TEXT    NOT NULL,
        direction    TEXT    NOT NULL,
        entry_time   INTEGER NOT NULL,
        entry_price  REAL    NOT NULL,
        stop_price   REAL    NOT NULL,
        target_price REAL    NOT NULL,
        exit_time    INTEGER,
        exit_price   REAL,
        exit_reason  TEXT,
        r_multiple   REAL,
        zone_ref     TEXT,
        decision_ref TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_trades_run_id ON trades (run_id);
      CREATE INDEX idx_trades_mode ON trades (mode);
      CREATE TABLE positions (
        symbol        TEXT    PRIMARY KEY,
        qty           INTEGER NOT NULL,
        avg_price     REAL    NOT NULL,
        open_trade_id TEXT,
        updated_at    INTEGER NOT NULL
      );
    `);
    if (opts.importColumns !== false) {
      db.exec(`
        ALTER TABLE trades ADD COLUMN management_mode TEXT;
        ALTER TABLE trades ADD COLUMN bars_in_trade INTEGER;
        ALTER TABLE trades ADD COLUMN mfe REAL;
        ALTER TABLE trades ADD COLUMN source TEXT;
        ALTER TABLE trades ADD COLUMN external_id TEXT;
        CREATE INDEX idx_trades_external_id ON trades (external_id);
      `);
    }
    return db;
  }

  function insertImported(db: Database.Database, externalId: string): void {
    db.prepare(
      `INSERT INTO trades
         (trade_id, run_id, mode, symbol, direction, entry_time, entry_price, stop_price,
          target_price, exit_time, exit_price, exit_reason, source, external_id, created_at)
       VALUES (?, NULL, 'live', 'NQ', 'long', 1000, 5000, 5000, 5000, 2000, 5010, 'manual',
               'ninjatrader', ?, 3000)`,
    ).run(`ninjatrader:${externalId}`, externalId);
  }

  function insertBacktest(db: Database.Database, tradeId: string): void {
    db.prepare(
      `INSERT INTO trades
         (trade_id, run_id, mode, symbol, direction, entry_time, entry_price, stop_price,
          target_price, created_at)
       VALUES (?, 'run-1', 'backtest', 'NQ', 'short', 1000, 5000, 5020, 4960, 3000)`,
    ).run(tradeId);
  }

  const columns = (db: Database.Database, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const count = (db: Database.Database, table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("carries imported rows into the current shape and drops the old table", () => {
    const db = oldTradesDb();
    insertImported(db, "A");

    initializeSchema(db);

    expect(columns(db, "trades")).toEqual(CURRENT_COLUMNS);
    expect(db.prepare("SELECT * FROM trades").all()).toEqual([
      {
        trade_id: "ninjatrader:A", source: "ninjatrader", external_id: "A", symbol: "NQ",
        direction: "long", quantity: null, entry_time: 1000, entry_price: 5000,
        exit_time: 2000, exit_price: 5010, commission: null, created_at: 3000,
      },
    ]);
    expect(columns(db, "trades_legacy")).toEqual([]);
    expect(
      db.prepare("SELECT 1 FROM schema_migrations WHERE name = 'trades_import_only'").get(),
    ).toBeDefined();
  });

  it("keeps the old table as trades_legacy when it holds rows that are not imports", () => {
    const db = oldTradesDb();
    insertImported(db, "A");
    insertBacktest(db, "bt-1");

    initializeSchema(db);

    expect(db.prepare("SELECT trade_id FROM trades").all()).toEqual([{ trade_id: "ninjatrader:A" }]);
    expect(count(db, "trades_legacy")).toBe(2);
    expect(columns(db, "trades_legacy")).toContain("zone_ref");
  });

  it("treats every row as a non-import when the table predates the import columns", () => {
    const db = oldTradesDb({ importColumns: false });
    insertBacktest(db, "bt-1");

    initializeSchema(db);

    expect(columns(db, "trades")).toEqual(CURRENT_COLUMNS);
    expect(count(db, "trades")).toBe(0);
    expect(count(db, "trades_legacy")).toBe(1);
  });

  it("is idempotent, and leaves the import index on the new table", () => {
    const db = oldTradesDb();
    insertImported(db, "A");

    initializeSchema(db);
    initializeSchema(db);

    expect(count(db, "trades")).toBe(1);
    expect(
      db.prepare("SELECT tbl_name FROM sqlite_master WHERE name = 'idx_trades_external_id'").get(),
    ).toEqual({ tbl_name: "trades" });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name IN ('idx_trades_run_id', 'idx_trades_mode')").all(),
    ).toEqual([]);
  });

  it("drops an empty positions table but leaves one that holds rows", () => {
    const empty = oldTradesDb();
    initializeSchema(empty);
    expect(columns(empty, "positions")).toEqual([]);

    const filled = oldTradesDb();
    filled.exec("INSERT INTO positions (symbol, qty, avg_price, updated_at) VALUES ('NQ', 1, 5000, 0)");
    initializeSchema(filled);
    expect(count(filled, "positions")).toBe(1);
  });

  it("creates only the current shape on a fresh database", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    expect(columns(db, "trades")).toEqual(CURRENT_COLUMNS);
    expect(columns(db, "positions")).toEqual([]);
    expect(columns(db, "trades_legacy")).toEqual([]);
  });
});

describe("bars per contract", () => {
  function insertLabelled(db: Database.Database, ts: number, contract: string | null): void {
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume, contract)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10, ?)`,
    ).run(ts, contract);
  }

  it("moves a legacy candles table into bars and leaves candles as a view over the front rows", () => {
    const db = legacyCandlesDb();
    db.exec("ALTER TABLE candles ADD COLUMN contract TEXT");
    insertBar(db, 1000, null);
    insertLabelled(db, 2000, "NQ 09-26");

    initializeSchema(db);

    const kind = db.prepare("SELECT type FROM sqlite_master WHERE name = 'candles'").get() as {
      type: string;
    };
    expect(kind.type).toBe("view");
    expect(db.prepare("SELECT timestamp, contract, front FROM bars ORDER BY timestamp").all()).toEqual([
      { timestamp: 1000, contract: "", front: 1 },
      { timestamp: 2000, contract: "NQ 09-26", front: 1 },
    ]);
    expect(db.prepare("SELECT contract FROM candles WHERE timestamp = 1000").get()).toEqual({
      contract: null,
    });
    expect(
      db.prepare("SELECT 1 FROM schema_migrations WHERE name = 'bars_per_contract'").get(),
    ).toBeDefined();

    insertLabelled(db, 2000, "NQ 12-26");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM bars WHERE timestamp = 2000").get() as { n: number }).n,
    ).toBe(2);

    initializeSchema(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM bars").get() as { n: number }).n).toBe(3);
  });

  it("swaps the table for the view in one step — a crash right after still leaves candles readable", () => {
    const db = legacyCandlesDb();
    insertBar(db, 1000, null);

    // Die on the first statement batch that follows the migration transaction.
    const realExec = db.exec.bind(db);
    (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (sql.includes("CREATE TABLE IF NOT EXISTS draw_commands")) {
        throw new Error("simulated crash after the migration");
      }
      return realExec(sql);
    };
    expect(() => initializeSchema(db)).toThrow(/simulated crash/);
    (db as unknown as { exec: (sql: string) => unknown }).exec = realExec;

    const kind = db.prepare("SELECT type FROM sqlite_master WHERE name = 'candles'").get() as
      | { type: string }
      | undefined;
    expect(kind?.type).toBe("view");
    expect(db.prepare("SELECT timestamp FROM candles").all()).toEqual([{ timestamp: 1000 }]);
    insertBar(db, 2000, null);
    expect((db.prepare("SELECT COUNT(*) AS n FROM bars").get() as { n: number }).n).toBe(2);

    initializeSchema(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM candles").get()).toEqual({ n: 2 });
  });

  it("a write through the view follows the day's assignment", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    db.prepare(
      `INSERT INTO session_contracts
         (symbol, session_day, start_unix, end_unix, contract, decided_by, updated_at)
       VALUES ('NQ', '2026-06-12', 50, 150, 'NQ 12-26', 'fetch', 0)`,
    ).run();
    insertLabelled(db, 100, "NQ 09-26");
    insertLabelled(db, 100, "NQ 12-26");
    insertLabelled(db, 200, "NQ 09-26"); // outside the assigned day: served
    expect(db.prepare("SELECT timestamp, contract FROM candles ORDER BY timestamp").all()).toEqual([
      { timestamp: 100, contract: "NQ 12-26" },
      { timestamp: 200, contract: "NQ 09-26" },
    ]);
    db.prepare("DELETE FROM candles WHERE timestamp = 100").run();
    expect(db.prepare("SELECT contract, front FROM bars WHERE timestamp = 100").all()).toEqual([
      { contract: "NQ 09-26", front: 0 },
    ]);
  });
});
