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

describe("price_basis migration", () => {
  it("adds the column and backfills what is already stored", () => {
    const db = legacyCandlesDb();
    insertBar(db, 1000, null); // NT8-fetched
    insertBar(db, 2000, "databento"); // imported

    initializeSchema(db);

    const cols = (db.prepare("PRAGMA table_info(candles)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("price_basis");

    // Justified only for rows present at migration time: the back-adjusted rows
    // were purged and every survivor verified against the lake at offset 0.
    expect(basisOf(db, 1000)).toBe("as_traded");
    expect(basisOf(db, 2000)).toBe("as_traded");
  });

  it("does NOT backfill on a later run — the whole point of the guard", () => {
    const db = legacyCandlesDb();
    insertBar(db, 1000, null);
    initializeSchema(db);
    expect(basisOf(db, 1000)).toBe("as_traded");

    // A row that arrives afterwards with an unknown basis — e.g. written while
    // the bridge could not report the merge policy. If the backfill were a
    // recurring "stamp every NULL", the next startup would relabel this as
    // as-traded and recreate exactly the blindness the column exists to remove.
    insertBar(db, 3000, null);
    expect(basisOf(db, 3000)).toBeNull();

    initializeSchema(db);

    expect(basisOf(db, 3000)).toBeNull();
    expect(basisOf(db, 1000)).toBe("as_traded");
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
  });
});
