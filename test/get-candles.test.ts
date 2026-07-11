import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/db/schema.js";
import { createGetCandlesHandler } from "../src/tools/get-candles.js";

function makeDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function seed(
  db: ReturnType<typeof makeDb>,
  symbol: string,
  timeframe: string,
  rows: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
) {
  const stmt = db.prepare(
    "INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    stmt.run(symbol, timeframe, r.timestamp, r.open, r.high, r.low, r.close, r.volume);
  }
}

// DST-safe ET-instant helper. Use this for any new test (avoid hardcoded
// `-04:00` / `-05:00` offsets — the offset depends on the date).
function et(yyyymmddhhmmss: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(yyyymmddhhmmss);
  if (!m) throw new Error(`bad ET instant: ${yyyymmddhhmmss}`);
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

// 2026-05-01 is a Friday. Under CME ETH session-day semantics, the
// query "2026-05-01" maps to the session running Thu 2026-04-30 18:00 ET
// → Fri 2026-05-01 17:00 ET. (Exclusive open, inclusive close.)
const NQ_MAY_1_RTH_OPEN = et("2026-05-01T09:30:00"); // 9:30 ET on May 1, mid-session

describe("get_candles handler — cache hit path", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns cached rows without calling the bridge when bridge is offline", async () => {
    // Sparse seed (2 bars in a 92-bar session) — under the auto-fill
    // flow, the cache is "partial" and would normally trigger a refetch.
    // We test the offline path here: with isConnected=false, ensureCached
    // skips the fetch and returns what's cached.
    seed(db, "NQ", "15m", [
      { timestamp: NQ_MAY_1_RTH_OPEN, open: 20100, high: 20120, low: 20090, close: 20110, volume: 1000 },
      { timestamp: NQ_MAY_1_RTH_OPEN + 900, open: 20110, high: 20130, low: 20100, close: 20125, volume: 1500 },
    ]);

    let bridgeCalled = false;
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => false,
      request: async () => {
        bridgeCalled = true;
        throw new Error("bridge should not be called when isConnected=false");
      },
      ingestCandles: () => {
        throw new Error("ingestCandles should not be called when isConnected=false");
      },
    });

    const result = await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "2026-05-01",
      end: "2026-05-01",
    });

    expect(bridgeCalled).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.symbol).toBe("NQ");
    expect(payload.timeframe).toBe("15m");
    expect(payload.count).toBe(2);
    expect(payload.candles[0].open).toBe(20100);
    expect(payload.candles[1].close).toBe(20125);
  });

  it("includes session-open boundary (first in-session bar at Apr 30 18:15 ET) in 'May 1' query", async () => {
    // The first bar inside session-day Fri 2026-05-01 close-stamps at
    // Thu 2026-04-30 18:15 ET (data window 18:00-18:14:59).
    seed(db, "NQ", "15m", [
      { timestamp: et("2026-04-30T18:15:00"), open: 1, high: 1, low: 1, close: 1, volume: 100 },
    ]);

    // Offline bridge: ensureCached short-circuits, SELECT returns what's seeded.
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => false,
      request: async () => { throw new Error("unreachable"); },
      ingestCandles: () => { throw new Error("unreachable"); },
    });

    const result = await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "2026-05-01",
      end: "2026-05-01",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.candles[0].volume).toBe(100);
  });

  it("includes session-close boundary (May 1 17:00 ET = inclusive end) in 'May 1' query", async () => {
    seed(db, "NQ", "15m", [
      { timestamp: et("2026-05-01T17:00:00"), open: 1, high: 1, low: 1, close: 1, volume: 200 },
    ]);

    const handler = createGetCandlesHandler({
      db,
      isConnected: () => false,
      request: async () => { throw new Error("unreachable"); },
      ingestCandles: () => { throw new Error("unreachable"); },
    });

    const result = await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "2026-05-01",
      end: "2026-05-01",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.candles[0].volume).toBe(200);
  });

  it("excludes prior session's last bar (Apr 30 17:00 ET = end of session-day Thu, not in May 1 query)", async () => {
    seed(db, "NQ", "15m", [
      { timestamp: et("2026-04-30T17:00:00"), open: 9, high: 9, low: 9, close: 9, volume: 999 },
    ]);

    const handler = createGetCandlesHandler({
      db,
      isConnected: () => false, // disconnected so empty result returns the "not connected" message
      request: async () => { throw new Error("unreachable"); },
      ingestCandles: () => { throw new Error("unreachable"); },
    });

    const result = await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "2026-05-01",
      end: "2026-05-01",
    });
    // Bar is in session-day Apr 30 (Thu), not May 1 (Fri). Query
    // returns zero rows → cache-miss path → "not connected" message.
    expect(result.content[0].text).toMatch(/NinjaTrader is not connected/);
  });

  it("rejects unsupported symbols", async () => {
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => true,
      request: async () => {
        throw new Error("unreachable");
      },
      ingestCandles: () => {
        throw new Error("unreachable");
      },
    });

    const result = await handler({
      symbol: "FOO",
      timeframe: "15m",
      start: "2026-05-01",
      end: "2026-05-01",
    });
    expect(result.content[0].text).toMatch(/Unsupported symbol/);
  });

  it("rejects malformed dates", async () => {
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => true,
      request: async () => {
        throw new Error("unreachable");
      },
      ingestCandles: () => {
        throw new Error("unreachable");
      },
    });

    const result = await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "not-a-date",
      end: "also-not",
    });
    expect(result.content[0].text).toMatch(/Invalid date format/);
  });

  it("rejects weekend session-day labels (no CME ETH session closes Sat)", async () => {
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => true,
      request: async () => { throw new Error("unreachable"); },
      ingestCandles: () => { throw new Error("unreachable"); },
    });

    // 2026-04-25 is a Saturday — no CME ETH session closes Sat.
    const result = await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "2026-04-25",
      end: "2026-04-25",
    });
    expect(result.content[0].text).toMatch(/Invalid session-day for NQ/);
  });

  it("on cache miss, sends request_candles with the symbol's tradingHoursTemplate", async () => {
    // Empty DB → cache miss → bridge.request("request_candles", payload)
    // gets called. The payload must carry the NQ session-template name
    // ("cme_us_index_futures_eth") so the C# add-on picks the right
    // NT8 TradingHours template. Regression guard against the add-on's old
    // wrong-template fetch bug.
    let capturedPayload: Record<string, unknown> | null = null;
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => true,
      request: async (_type, payload) => {
        capturedPayload = payload as Record<string, unknown>;
        return {
          v: 1, id: "x", type: "candles_response",
          symbol: "NQ", timeframe: "15m", candles: [],
        };
      },
      ingestCandles: () => ({ inserted: 0, aggregated: {} }),
    });

    await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "2026-05-01",
      end: "2026-05-01",
    });

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.tradingHoursTemplate).toBe("cme_us_index_futures_eth");
  });

  it("returns clear error when cache is empty and bridge disconnected", async () => {
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => false,
      request: async () => {
        throw new Error("should not call");
      },
      ingestCandles: () => {
        throw new Error("should not call");
      },
    });

    const result = await handler({
      symbol: "NQ",
      timeframe: "15m",
      start: "2026-05-01",
      end: "2026-05-01",
    });
    expect(result.content[0].text).toMatch(/NinjaTrader is not connected/);
  });
});
