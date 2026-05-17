import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { initializeSchema } from "../src/db/schema.js";
import { validateSessionDay } from "../src/core/cache/validator.js";
import type { SessionDay } from "../src/core/sessions/types.js";
import type { Timeframe } from "../src/core/types.js";

// Far-future "now" so EDT and EST fixtures both look like closed sessions.
const NOW_FUTURE = 2_000_000_000;

function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function sd(label: string, startUnix: number, endUnix: number): SessionDay {
  return { label, startUnix, endUnix };
}

// Mirrors the validator's own formula; used to seed full-session
// fixtures programmatically so tests never hardcode unix values.
function generateExpectedStamps(day: SessionDay, tf: Timeframe): number[] {
  const period: Record<Timeframe, number> = {
    "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
  };
  const p = period[tf];
  const dur = day.endUnix - day.startUnix;
  const full = Math.floor(dur / p);
  const stub = dur % p !== 0;
  const out: number[] = [];
  for (let i = 1; i <= full; i++) out.push(day.startUnix + i * p);
  if (stub) out.push(day.endUnix);
  return out;
}

function insertBar(db: DatabaseType, symbol: string, tf: Timeframe, ts: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, 1, 1, 1, 1, 1)`,
  ).run(symbol, tf, ts);
}

function seedFull(db: DatabaseType, symbol: string, tf: Timeframe, day: SessionDay): void {
  for (const t of generateExpectedStamps(day, tf)) insertBar(db, symbol, tf, t);
}

// EDT session-day fixture: opens 2026-04-30 18:00 EDT (= 22:00 UTC),
// closes 2026-05-01 17:00 EDT (= 21:00 UTC). 23h exactly.
const EDT_DAY: SessionDay = sd(
  "2026-05-01",
  Date.UTC(2026, 3, 30, 22, 0, 0) / 1000,
  Date.UTC(2026, 4, 1, 21, 0, 0) / 1000,
);

// EST session-day fixture: opens 2026-01-12 18:00 EST (= 23:00 UTC),
// closes 2026-01-13 17:00 EST (= 22:00 UTC). 23h exactly.
const EST_DAY: SessionDay = sd(
  "2026-01-13",
  Date.UTC(2026, 0, 12, 23, 0, 0) / 1000,
  Date.UTC(2026, 0, 13, 22, 0, 0) / 1000,
);

describe("validateSessionDay — full sessions at every timeframe pass", () => {
  for (const tf of ["5m", "15m", "30m", "1h", "2h", "4h"] as Timeframe[]) {
    it(`${tf}: full EDT session → ok`, () => {
      const db = makeDb();
      seedFull(db, "NQ", tf, EDT_DAY);
      const r = validateSessionDay(db, "NQ", EDT_DAY, tf, NOW_FUTURE);
      expect(r.status).toBe("ok");
      expect(r.missing).toEqual([]);
      expect(r.extra).toEqual([]);
    });
  }
});

describe("validateSessionDay — EST session", () => {
  it("4h: full EST session → ok", () => {
    const db = makeDb();
    seedFull(db, "NQ", "4h", EST_DAY);
    const r = validateSessionDay(db, "NQ", EST_DAY, "4h", NOW_FUTURE);
    expect(r.status).toBe("ok");
    expect(r.missing).toEqual([]);
  });
});

describe("validateSessionDay — missing bars", () => {
  it("4h: missing stub at endUnix → mismatch, missing=[endUnix]", () => {
    const db = makeDb();
    for (let i = 1; i <= 5; i++) {
      insertBar(db, "NQ", "4h", EDT_DAY.startUnix + i * 14400);
    }
    const r = validateSessionDay(db, "NQ", EDT_DAY, "4h", NOW_FUTURE);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual([EDT_DAY.endUnix]);
    expect(r.extra).toEqual([]);
  });

  it("2h: missing 1h stub at endUnix → mismatch", () => {
    const db = makeDb();
    for (let i = 1; i <= 11; i++) {
      insertBar(db, "NQ", "2h", EDT_DAY.startUnix + i * 7200);
    }
    const r = validateSessionDay(db, "NQ", EDT_DAY, "2h", NOW_FUTURE);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual([EDT_DAY.endUnix]);
  });

  it("1h: missing the 17:00 close-stamp → mismatch", () => {
    // For 1h on a 23h session, fullBarCount=23 and hasStub=false. The
    // 23rd full bar's close-stamp equals endUnix — it's a regular full
    // bar that happens to land on the session close, not a stub.
    const db = makeDb();
    for (let i = 1; i <= 22; i++) {
      insertBar(db, "NQ", "1h", EDT_DAY.startUnix + i * 3600);
    }
    const r = validateSessionDay(db, "NQ", EDT_DAY, "1h", NOW_FUTURE);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual([EDT_DAY.endUnix]);
  });
});

describe("validateSessionDay — extra bars", () => {
  it("4h: extra bar at non-boundary timestamp → mismatch, extra populated", () => {
    const db = makeDb();
    seedFull(db, "NQ", "4h", EDT_DAY);
    // Insert a bar 5h after open — not a 4h boundary, not the stub.
    const stray = EDT_DAY.startUnix + 5 * 3600;
    insertBar(db, "NQ", "4h", stray);
    const r = validateSessionDay(db, "NQ", EDT_DAY, "4h", NOW_FUTURE);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toContain(stray);
    expect(r.missing).toEqual([]);
  });
});

describe("validateSessionDay — fully-empty session-day", () => {
  it("4h: zero bars → mismatch with all 6 expected as missing", () => {
    const db = makeDb();
    const r = validateSessionDay(db, "NQ", EDT_DAY, "4h", NOW_FUTURE);
    expect(r.status).toBe("mismatch");
    expect(r.actual).toEqual([]);
    expect(r.missing.length).toBe(6);
  });
});

describe("validateSessionDay — in-progress", () => {
  it("endUnix > nowUnix → skipped with reason 'in-progress'", () => {
    const db = makeDb();
    const midSession = EDT_DAY.startUnix + 1000;
    const r = validateSessionDay(db, "NQ", EDT_DAY, "4h", midSession);
    expect(r.status).toBe("skipped");
    expect(r.skipReason).toBe("in-progress");
  });
});

describe("validateSessionDay — generic stamp computation", () => {
  it("23h session produces correct bar count at every TF", () => {
    const db = makeDb();
    // Synthetic 23h session — any startUnix works because unix seconds
    // are TZ-agnostic; geometry is invariant.
    const day = sd("test", 1_700_000_000, 1_700_000_000 + 82800);
    const counts: Record<Timeframe, number> = {
      "5m": 276, "15m": 92, "30m": 46, "1h": 23, "2h": 12, "4h": 6,
    };
    for (const tf of Object.keys(counts) as Timeframe[]) {
      const r = validateSessionDay(db, "NQ", day, tf, NOW_FUTURE);
      expect(r.expected.length).toBe(counts[tf]);
    }
  });
});
