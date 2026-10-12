import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import {
  expectedCloseStamps,
  validateSessionDay,
} from "../validator.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// Mon 2026-05-04 session-day (EDT).
const D1 = { label: "2026-05-04", startUnix: unix(2026, 5, 3, 22), endUnix: unix(2026, 5, 4, 21) };
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

// Insert every expected 15s stamp for `day` except the `omit`ted ones.
function seed15s(
  db: Database.Database,
  day: { startUnix: number; endUnix: number },
  omit: readonly number[] = [],
): void {
  const skip = new Set(omit);
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ', '15s', ?, 1, 2, 0.5, 1.5, 10)`,
  );
  db.transaction(() => {
    for (const t of expectedCloseStamps(day, "15s")) {
      if (!skip.has(t)) stmt.run(t);
    }
  })();
}

function seedWithHoles(
  db: Database.Database,
  symbol: string,
  omit: readonly number[],
  dailyVolume?: number,
): number {
  const skip = new Set(omit);
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, 1, 2, 0.5, 1.5, ?)`,
  );
  let volume = 0;
  expectedCloseStamps(D1, "15m").forEach((t, i) => {
    if (skip.has(i)) return;
    stmt.run(symbol, "15m", t, 10);
    volume += 10;
  });
  if (dailyVolume !== undefined) stmt.run(symbol, "1d", D1.endUnix, dailyVolume);
  return volume;
}

describe("15s sparse tolerance (zero-tick buckets)", () => {
  it("accepts a closed 15s day with scattered zero-tick gaps as ok", () => {
    const db = memDb();
    const all = expectedCloseStamps(D1, "15s");
    const omit = all.filter((_, i) => i % 138 === 137); // 40 isolated stamps
    seed15s(db, D1, omit);
    const r = validateSessionDay(db, "NQ", { ...D1 }, "15s", NOW);
    expect(r.status).toBe("ok");
    expect(r.missing.length).toBe(omit.length); // diagnostics stay populated
  });

  it("rejects when more than 2% of stamps are missing", () => {
    const db = memDb();
    const all = expectedCloseStamps(D1, "15s");
    const omit = all.filter((_, i) => i % 40 === 39); // 138 stamps = 2.5%
    seed15s(db, D1, omit);
    expect(validateSessionDay(db, "NQ", { ...D1 }, "15s", NOW).status).toBe("mismatch");
  });

  it("rejects a contiguous gap longer than 2 minutes but allows one at the limit", () => {
    const all = expectedCloseStamps(D1, "15s");
    const nine = memDb(); // 9 x 15s = 135s hole: a real outage, not a lull
    seed15s(nine, D1, all.slice(1000, 1009));
    expect(validateSessionDay(nine, "NQ", { ...D1 }, "15s", NOW).status).toBe("mismatch");
    const eight = memDb(); // 8 x 15s = 120s: at the tolerance boundary
    seed15s(eight, D1, all.slice(1000, 1008));
    expect(validateSessionDay(eight, "NQ", { ...D1 }, "15s", NOW).status).toBe("ok");
  });

  it("rejects a sparse day that also holds an off-grid orphan stamp", () => {
    const db = memDb();
    const all = expectedCloseStamps(D1, "15s");
    seed15s(db, D1, all.filter((_, i) => i % 1000 === 999));
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '15s', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(D1.startUnix + 7);
    expect(validateSessionDay(db, "NQ", { ...D1 }, "15s", NOW).status).toBe("mismatch");
  });

  it("keeps denser timeframes exact — one missing 15m bar is still a mismatch", () => {
    const db = memDb();
    seed15m(db, D1, 1);
    expect(validateSessionDay(db, "NQ", { ...D1 }, "15m", NOW).status).toBe("mismatch");
  });
});

describe("expectedBarCount at 15s", () => {
  it("counts 5,520 bars for a 23h CME session-day", async () => {
    const { expectedBarCount } = await import("../validator.js");
    expect(expectedBarCount(D1, "15s")).toBe(5520);
  });
});

describe("thin instruments (volume against the 1d bar)", () => {
  it("accepts empty buckets when the day's volume matches its 1d bar", () => {
    const db = memDb();
    const volume = seedWithHoles(db, "M6E", [0, 1, 2, 40], 880);
    expect(volume).toBe(880);
    const r = validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW);
    expect(r.status).toBe("ok");
    expect(r.missing.length).toBe(4);
  });

  it("absorbs drift between NT8's stores inside the tolerance", () => {
    const db = memDb();
    seedWithHoles(db, "M6E", [0, 1, 2, 40], 884);
    expect(validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW).status).toBe("ok");
  });

  it("rejects a day whose volume falls short of its 1d bar", () => {
    const db = memDb();
    seedWithHoles(db, "M6E", [0, 1, 2, 40], 920);
    const r = validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW);
    expect(r.status).toBe("mismatch");
    expect(r.note).toBe("volume 880 vs 920 on the 1d bar");
    expect(r.needsDailyBar).toBeUndefined();
  });

  it("asks for the daily bar again when the cached one is short of the day's own bars", () => {
    const db = memDb();
    seedWithHoles(db, "M6E", [0, 1, 2, 40], 600);
    const r = validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW);
    expect(r.status).toBe("mismatch");
    expect(r.needsDailyBar).toBe(true);
  });

  it("does not ask again for a daily bar it accepts at the edge of the tolerance", () => {
    const db = memDb();
    seedWithHoles(db, "M6E", [0, 1, 2, 40], 2000);
    // 2,010 against 2,000: exactly the tolerance.
    db.prepare(
      `UPDATE bars SET volume = volume + 1130
        WHERE symbol = 'M6E' AND timeframe = '15m' AND timestamp = ?`,
    ).run(D1.endUnix);
    const r = validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW);
    expect(r.status).toBe("ok");
    expect(r.needsDailyBar).toBeUndefined();
  });

  it("rejects a day with no 1d bar to check against", () => {
    const db = memDb();
    seedWithHoles(db, "M6E", [0, 1, 2, 40]);
    const r = validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW);
    expect(r.status).toBe("mismatch");
    expect(r.note).toContain("no 1d bar");
    expect(r.needsDailyBar).toBe(true);
  });

  it("rejects a day cut off before the close even when the volumes agree", () => {
    const db = memDb();
    const cut = Array.from({ length: 32 }, (_, i) => 60 + i);
    seedWithHoles(db, "M6E", cut, 600);
    const r = validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW);
    expect(r.status).toBe("mismatch");
    expect(r.note).toContain("before the session close");
  });

  it("never tolerates an off-grid stamp", () => {
    const db = memDb();
    seedWithHoles(db, "M6E", [0, 1, 2, 40], 890);
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('M6E', '15m', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(D1.startUnix + 450);
    expect(validateSessionDay(db, "M6E", { ...D1 }, "15m", NOW).status).toBe("mismatch");
  });

  it("leaves a liquid instrument exact on the same bars", () => {
    const db = memDb();
    seedWithHoles(db, "NQ", [0, 1, 2, 40], 880);
    expect(validateSessionDay(db, "NQ", { ...D1 }, "15m", NOW).status).toBe("mismatch");
  });

  it("flags a 1d bar that holds less volume than the day's intraday bars", () => {
    const db = memDb();
    seedWithHoles(db, "M6E", [0, 1, 2, 40], 600);
    const stale = validateSessionDay(db, "M6E", { ...D1 }, "1d", NOW);
    expect(stale.status).toBe("mismatch");
    expect(stale.note).toContain("fetched before the close");

    db.prepare(`UPDATE bars SET volume = 880 WHERE symbol = 'M6E' AND timeframe = '1d'`).run();
    expect(validateSessionDay(db, "M6E", { ...D1 }, "1d", NOW).status).toBe("ok");
  });
});
