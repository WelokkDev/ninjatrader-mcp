import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import { backtestDataPreflight } from "../preflight.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

const D1_START = unix(2026, 5, 3, 22); // Mon 2026-05-04 session open
const D2_START = unix(2026, 5, 4, 22);
const NOW = unix(2026, 6, 1, 0);

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function seed5m(db: Database.Database, startUnix: number, skip = 0): void {
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
  );
  for (let i = 1; i <= 276 - skip; i++) stmt.run(startUnix + i * 300);
}

describe("backtestDataPreflight", () => {
  it("passes a fully-cached range", () => {
    const db = memDb();
    seed5m(db, D1_START);
    seed5m(db, D2_START);
    const msg = backtestDataPreflight(
      db,
      { symbol: "NQ", startDay: "2026-05-04", endDay: "2026-05-05", lookbackDays: 0 },
      NOW,
    );
    expect(msg).toBeNull();
  });

  it("fails closed on an incomplete range, naming the bad day and the remedy", () => {
    const db = memDb();
    seed5m(db, D1_START);
    seed5m(db, D2_START, 5);
    const msg = backtestDataPreflight(
      db,
      { symbol: "NQ", startDay: "2026-05-04", endDay: "2026-05-05", lookbackDays: 0 },
      NOW,
    );
    expect(msg).toMatch(/2026-05-05/);
    expect(msg).toMatch(/5m/);
    expect(msg).toMatch(/get_candles|prefetch_candles/);
  });

  it("fails closed on an impossible calendar date", () => {
    const msg = backtestDataPreflight(
      memDb(),
      { symbol: "NQ", startDay: "2026-02-30", endDay: "2026-03-02" },
      NOW,
    );
    expect(msg).toMatch(/impossible/);
  });

  it("fails closed on a weekend label", () => {
    const msg = backtestDataPreflight(
      memDb(),
      { symbol: "NQ", startDay: "2026-05-02", endDay: "2026-05-05" },
      NOW,
    );
    expect(msg).toMatch(/No session span/);
  });

  it("fails closed on an unknown symbol", () => {
    const msg = backtestDataPreflight(
      memDb(),
      { symbol: "ZZ", startDay: "2026-05-04", endDay: "2026-05-05" },
      NOW,
    );
    expect(msg).toMatch(/No session config/);
  });

  it("fails closed on an inverted range", () => {
    const msg = backtestDataPreflight(
      memDb(),
      { symbol: "NQ", startDay: "2026-05-05", endDay: "2026-05-04" },
      NOW,
    );
    expect(msg).toMatch(/not before/);
  });

  it("validates the lookback window before startDay", () => {
    const db = memDb();
    seed5m(db, D2_START); // range day cached; lookback day (05-04) missing
    const msg = backtestDataPreflight(
      db,
      { symbol: "NQ", startDay: "2026-05-05", endDay: "2026-05-05", lookbackDays: 1 },
      NOW,
    );
    expect(msg).toMatch(/2026-05-04/);
    expect(msg).toMatch(/lookback/i);

    seed5m(db, D1_START);
    expect(
      backtestDataPreflight(
        db,
        { symbol: "NQ", startDay: "2026-05-05", endDay: "2026-05-05", lookbackDays: 1 },
        NOW,
      ),
    ).toBeNull();
  });

  it("refuses a range ending on an in-progress session-day (detached runs must end closed)", () => {
    const db = memDb();
    seed5m(db, D1_START);
    const midD2 = D2_START + 3600;
    const msg = backtestDataPreflight(
      db,
      { symbol: "NQ", startDay: "2026-05-04", endDay: "2026-05-05", lookbackDays: 0 },
      midD2,
    );
    expect(msg).toMatch(/in.progress/i);
    expect(msg).toMatch(/2026-05-05/);
  });
});
