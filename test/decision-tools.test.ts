import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createGetPlayingFieldHandler } from "../src/tools/get-playing-field.js";
import { createScanForTradeHandler } from "../src/tools/scan-for-trade.js";

// Outer-repo tool tests for get_playing_field + scan_for_trade. They exercise the PUBLIC plumbing — symbol/asOf validation, cache load, frozen-view build,
// config assembly (real strategy file + SMA preset), and the private decideAtBar call, over an in-memory SQLite cache. 
// The decision verdict on this synthetic data is expected to be "no"; the decideAtBar branch coverage lives in the private decide-at-bar.test.ts. 
// Here we prove the tool returns a well-formed Decision / PlayingField (not an error) and that the error paths fire.

// DST-safe ET wall-clock → unix seconds (same helper as the frozen-view tests).
function et(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (!m) throw new Error(`bad ET instant: ${iso}`);
  const [, y, mo, d, hh, mm, ss] = m;
  const probeMs = Date.UTC(+y, +mo - 1, +d, 12, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(probeMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const localAsUtcMs = Date.UTC(
    +get("year"), +get("month") - 1, +get("day"),
    +get("hour"), +get("minute"), +get("second"),
  );
  const offsetMs = localAsUtcMs - probeMs;
  return Math.floor(
    (Date.UTC(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0) - offsetMs) / 1000,
  );
}

const ASOF = et("2026-04-21T14:00:00"); // Tue 14:00 ET, inside 09:30–15:30

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE candles (
       symbol TEXT NOT NULL,
       timeframe TEXT NOT NULL,
       timestamp INTEGER NOT NULL,
       open REAL NOT NULL,
       high REAL NOT NULL,
       low REAL NOT NULL,
       close REAL NOT NULL,
       volume REAL NOT NULL,
       PRIMARY KEY (symbol, timeframe, timestamp)
     )`,
  );
  return db;
}

// Seed a gentle 5m uptrend of `n` bars ending at ASOF.
function seed5m(db: Database.Database, symbol = "NQ", n = 120): void {
  const insert = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const ts = ASOF - (n - 1 - i) * 300;
      const c = 100 + 0.25 * i;
      insert.run(symbol, "5m", ts, c - 0.25, c + 0.5, c - 0.5, c, 100 + i);
    }
  });
  tx();
}

function parse(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("get_playing_field tool", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("rejects an unsupported symbol", async () => {
    const handler = createGetPlayingFieldHandler({ db });
    const r = await handler({ symbol: "DOGE", asOf: ASOF });
    expect(r.content[0].text).toMatch(/Unsupported symbol/);
  });

  it("rejects a non-positive asOf", async () => {
    const handler = createGetPlayingFieldHandler({ db });
    const r = await handler({ symbol: "NQ", asOf: 0 });
    expect(r.content[0].text).toMatch(/asOf must be a positive/);
  });

  it("errors on a cache miss (no data) pointing at get_candles", async () => {
    const handler = createGetPlayingFieldHandler({ db });
    const r = await handler({ symbol: "NQ", asOf: ASOF });
    expect(r.content[0].text).toMatch(/No cached 5m data/);
    expect(r.content[0].text).toMatch(/get_candles/);
  });

  it("returns a composed PlayingField over seeded data", async () => {
    seed5m(db);
    const handler = createGetPlayingFieldHandler({ db });
    const r = await handler({ symbol: "NQ", asOf: ASOF });
    const payload = parse(r) as {
      symbol: string;
      playingField?: Record<string, unknown>;
      tradingTrend?: { verdict: string };
      dailyAtr?: number;
    };
    expect(payload.symbol).toBe("NQ");
    expect(payload.playingField).toBeTruthy();
    expect(Object.keys(payload.playingField!).length).toBeGreaterThan(0);
    expect(["up", "down", "sideways"]).toContain(payload.tradingTrend!.verdict);
    expect(typeof payload.dailyAtr).toBe("number");
  });
});

describe("scan_for_trade tool", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("rejects an unsupported symbol", async () => {
    const handler = createScanForTradeHandler({ db });
    const r = await handler({ symbol: "DOGE", asOf: ASOF });
    expect(r.content[0].text).toMatch(/Unsupported symbol/);
  });

  it("errors on a cache miss", async () => {
    const handler = createScanForTradeHandler({ db });
    const r = await handler({ symbol: "NQ", asOf: ASOF });
    expect(r.content[0].text).toMatch(/No cached 5m data/);
  });

  it("returns a well-formed Decision over seeded data", async () => {
    seed5m(db);
    const handler = createScanForTradeHandler({ db });
    const r = await handler({ symbol: "NQ", asOf: ASOF });
    const payload = parse(r) as {
      symbol: string;
      decision: { trade: string; reason?: string; trace: unknown[] };
    };
    expect(payload.symbol).toBe("NQ");
    expect(["yes", "no"]).toContain(payload.decision.trade);
    expect(Array.isArray(payload.decision.trace)).toBe(true);
    expect(payload.decision.trace.length).toBeGreaterThan(0);
    // First trace step is always the session-window gate.
    expect((payload.decision.trace[0] as { step: string }).step).toBe(
      "session-window",
    );
  });

  it("honors configOverrides (deep-merged onto the flat config)", async () => {
    seed5m(db);
    const handler = createScanForTradeHandler({ db });
    // An impossible session window forces the very first gate to fail, proves overrides reach the decision.
    const r = await handler({
      symbol: "NQ",
      asOf: ASOF,
      configOverrides: {
        session: {
          tradableSessionWindow: {
            start: "23:00",
            end: "23:30",
            tz: "America/New_York",
          },
        },
      },
    });
    const payload = parse(r) as { decision: { trade: string; reason?: string } };
    expect(payload.decision.trade).toBe("no");
    expect(payload.decision.reason).toBe("outside-tradable-session");
  });
});
