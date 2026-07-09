import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import { validateRangeComplete } from "../validator.js";
import { CME_US_INDEX_FUTURES_ETH } from "../../sessions/templates.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// Mon 2026-05-04 .. Tue 2026-05-05 session-days (EDT).
const D1 = { label: "2026-05-04", startUnix: unix(2026, 5, 3, 22), endUnix: unix(2026, 5, 4, 21) };
const D2 = { label: "2026-05-05", startUnix: unix(2026, 5, 4, 22), endUnix: unix(2026, 5, 5, 21) };
const NOW = unix(2026, 6, 1, 0);

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

// Full 23h session-day of 15m bars = 92 close-stamps; `skip` drops that many
// stamps off the end to make the day structurally incomplete.
function seed15m(db: Database.Database, day: { startUnix: number }, skip = 0): void {
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ', '15m', ?, 1, 2, 0.5, 1.5, 10)`,
  );
  for (let i = 1; i <= 92 - skip; i++) stmt.run(day.startUnix + i * 900);
}

describe("expectedBarCount at 15s", () => {
  it("counts 5,520 bars for a 23h CME session-day", async () => {
    const { expectedBarCount } = await import("../validator.js");
    expect(expectedBarCount(D1, "15s")).toBe(5520);
  });
});

describe("validateRangeComplete", () => {
  it("reports ok over a fully-cached range", () => {
    const db = memDb();
    seed15m(db, D1);
    seed15m(db, D2);
    const r = validateRangeComplete(db, "NQ", "15m", D1.startUnix, D2.endUnix, CME_US_INDEX_FUTURES_ETH, NOW);
    expect(r).toMatchObject({ ok: true, daysChecked: 2, badDays: [], inProgressDays: [] });
  });

  it("lists an incomplete day with its missing count", () => {
    const db = memDb();
    seed15m(db, D1);
    seed15m(db, D2, 3);
    const r = validateRangeComplete(db, "NQ", "15m", D1.startUnix, D2.endUnix, CME_US_INDEX_FUTURES_ETH, NOW);
    expect(r.ok).toBe(false);
    expect(r.badDays).toEqual([
      { label: "2026-05-05", status: "incomplete", missing: 3, extra: 0 },
    ]);
  });

  it("classifies a day with zero rows as empty", () => {
    const db = memDb();
    seed15m(db, D1);
    const r = validateRangeComplete(db, "NQ", "15m", D1.startUnix, D2.endUnix, CME_US_INDEX_FUTURES_ETH, NOW);
    expect(r.ok).toBe(false);
    expect(r.badDays).toEqual([
      { label: "2026-05-05", status: "empty", missing: 92, extra: 0 },
    ]);
  });

  it("skips in-progress days and reports them separately", () => {
    const db = memDb();
    seed15m(db, D1);
    const midD2 = D2.startUnix + 100;
    const r = validateRangeComplete(db, "NQ", "15m", D1.startUnix, D2.endUnix, CME_US_INDEX_FUTURES_ETH, midD2);
    expect(r.ok).toBe(true);
    expect(r.inProgressDays).toEqual(["2026-05-05"]);
    expect(r.daysChecked).toBe(2);
  });

  it("is neutral over a range containing no session days", () => {
    const db = memDb();
    // Sat 2026-05-02 12:00 → Sat 16:00 UTC-ish window inside the weekend gap.
    const r = validateRangeComplete(
      db, "NQ", "15m", unix(2026, 5, 2, 16), unix(2026, 5, 2, 20), CME_US_INDEX_FUTURES_ETH, NOW,
    );
    expect(r).toMatchObject({ ok: true, daysChecked: 0 });
  });
});
