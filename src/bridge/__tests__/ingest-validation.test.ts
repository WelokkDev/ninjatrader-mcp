import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { ingestCandles } from "../ingest.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-day 2026-05-01 (Fri): Apr 30 18:00 EDT → May 1 17:00 EDT.
const DAY_START = unix(2026, 4, 30, 22);
const TS = DAY_START + 900; // first canonical 15m stamp

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function ingestOne(db: Database.Database, candle: Record<string, number>) {
  return ingestCandles(
    "NQ",
    "15m",
    [candle as unknown as Parameters<typeof ingestCandles>[2][number]],
    db,
    { mode: "append", nowUnix: TS + 60 },
  );
}

// The shared validator must reject OHLC-ordering violations so a feed glitch
// can't flow into candles.db (live bar_close and historical fetches share it).
describe("isValidCandle OHLC ordering", () => {
  it("drops a bar whose high is below the body", () => {
    const db = memDb();
    const res = ingestOne(db, {
      timestamp: TS, open: 100, high: 99, low: 98, close: 100.5, volume: 10,
    });
    expect(res.inserted).toBe(0);
    expect(res.dropped).toBe(1);
  });

  it("drops a bar whose low is above the body", () => {
    const db = memDb();
    const res = ingestOne(db, {
      timestamp: TS, open: 100, high: 101, low: 100.4, close: 100.2, volume: 10,
    });
    expect(res.inserted).toBe(0);
    expect(res.dropped).toBe(1);
  });

  it("still inserts a well-ordered bar (body equal to range allowed)", () => {
    const db = memDb();
    const res = ingestOne(db, {
      timestamp: TS, open: 100, high: 100.5, low: 100, close: 100.5, volume: 10,
    });
    expect(res.inserted).toBe(1);
    expect(res.dropped).toBe(0);
  });
});
