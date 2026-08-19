import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createBarCloseHandler, ingestCandles } from "../ingest.js";
import { getInstrumentConfig } from "../../core/sessions/registry.js";
import { loadCalendar } from "../../core/sessions/calendar.js";
import { recomputeDerivedForSessionDay } from "../../core/cache/derived.js";
import { barCloseMessageSchema } from "../protocol.js";

// price_basis through the ingest write paths, which is what makes a
// merge-policy flip visible per row.

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-day 2026-05-01 (Fri): Apr 30 18:00 EDT → May 1 17:00 EDT.
const DAY_START = unix(2026, 4, 30, 22);
const DAY_END = DAY_START + 82_800;
const AFTER_CLOSE = DAY_END + 3_600;

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function bars15m(fromIdx: number, toIdx: number) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    out.push({
      timestamp: DAY_START + i * 900,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10,
    });
  }
  return out;
}

function basisOf(db: Database.Database, tf: string): Array<string | null> {
  return (
    db
      .prepare(
        `SELECT DISTINCT price_basis AS pb FROM candles WHERE symbol='NQ' AND timeframe=? ORDER BY pb`,
      )
      .all(tf) as Array<{ pb: string | null }>
  ).map((r) => r.pb);
}

describe("price_basis through ingest", () => {
  it("labels raw rows with the bridge-reported basis", () => {
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(1, 92), db, {
      mode: "day-refill",
      nowUnix: AFTER_CLOSE,
      priceBasis: "as_traded",
    });
    expect(basisOf(db, "15m")).toEqual(["as_traded"]);
  });

  it("derived rows inherit their constituents' basis", () => {
    // 30m-4h are recomputed FROM the 15m rows, so they must be no more certain
    // than what built them — and no less: pre-fix every derived row was NULL.
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(1, 92), db, {
      mode: "day-refill",
      nowUnix: AFTER_CLOSE,
      priceBasis: "as_traded",
    });
    for (const tf of ["30m", "1h", "2h", "4h"]) {
      expect(basisOf(db, tf), tf).toEqual(["as_traded"]);
    }
  });

  it("an unlabelled refill stores NULL and a recompute propagates the doubt", () => {
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(1, 92), db, {
      mode: "day-refill",
      nowUnix: AFTER_CLOSE,
      priceBasis: "as_traded",
    });
    // Re-fetched by an AddOn that reports no policy. Keeping the old
    // as_traded label on 1h rows rebuilt from unlabelled 15m would manufacture
    // certainty.
    ingestCandles("NQ", "15m", bars15m(1, 92), db, {
      mode: "day-refill",
      nowUnix: AFTER_CLOSE,
    });
    expect(basisOf(db, "15m")).toEqual([null]);
    expect(basisOf(db, "1h")).toEqual([null]);
  });

  it("'unknown' from the wire is stored as NULL, not as a third basis", () => {
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(1, 92), db, {
      mode: "day-refill",
      nowUnix: AFTER_CLOSE,
      priceBasis: "unknown",
    });
    expect(basisOf(db, "15m")).toEqual([null]);
  });

  it("bar_close carries priceBasis through the wire schema", () => {
    // Zod strips unknown keys silently, which is how the AddOn's computed
    // basis got discarded with no error.
    const msg = barCloseMessageSchema.parse({
      v: 1,
      type: "bar_close",
      symbol: "NQ",
      timeframe: "15m",
      candle: { timestamp: DAY_START + 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
      priceBasis: "as_traded",
    });
    expect(msg.priceBasis).toBe("as_traded");
  });
});

describe("the registered bar_close handler", () => {
  // Drives the registered handler, not just ingestCandles beneath it, so a
  // dropped pass-through fails here.
  it("threads the wire priceBasis into the stored row", () => {
    const db = memDb();
    createBarCloseHandler(db)({
      v: 1,
      type: "bar_close",
      symbol: "NQ",
      timeframe: "15m",
      candle: { timestamp: DAY_START + 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
      priceBasis: "as_traded",
      dataSource: "My Broker Feed",
    });
    expect(basisOf(db, "15m")).toEqual(["as_traded"]);
  });

  it("still quarantines the Simulated Data Feed", () => {
    const db = memDb();
    createBarCloseHandler(db)({
      v: 1,
      type: "bar_close",
      symbol: "NQ",
      timeframe: "15m",
      candle: { timestamp: DAY_START + 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
      priceBasis: "as_traded",
      dataSource: "Simulated Data Feed",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM candles").get()).toMatchObject({ n: 0 });
  });
});

describe("derived-basis rule under heterogeneity", () => {
  it("a day whose 15m rows carry TWO bases derives NULL, not a coin flip", () => {
    // An "any labelled wins" misimplementation passes every homogeneous
    // fixture, so only this case pins the rule.
    const db = memDb();
    ingestCandles("NQ", "15m", bars15m(1, 92), db, {
      mode: "day-refill",
      nowUnix: AFTER_CLOSE,
      priceBasis: "as_traded",
    });
    db.prepare(
      `UPDATE candles SET price_basis = 'back_adjusted'
        WHERE symbol='NQ' AND timeframe='15m' AND timestamp <= ?`,
    ).run(DAY_START + 46 * 900);

    const config = getInstrumentConfig("NQ");
    const calendar = loadCalendar(db, config.session.name);
    recomputeDerivedForSessionDay(
      db, "NQ",
      { label: "2026-05-01", startUnix: DAY_START, endUnix: DAY_END },
      config, calendar, AFTER_CLOSE,
    );
    for (const tf of ["30m", "1h", "2h", "4h"]) {
      expect(basisOf(db, tf), tf).toEqual([null]);
    }
  });
});
