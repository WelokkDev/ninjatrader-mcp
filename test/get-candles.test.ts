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

const NQ_MAY_1 = Math.floor(Date.parse("2026-05-01T13:30:00Z") / 1000); // 9:30 ET in May (EDT)

describe("get_candles handler — cache hit path", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns cached rows without calling the bridge", async () => {
    seed(db, "NQ", "15m", [
      { timestamp: NQ_MAY_1, open: 20100, high: 20120, low: 20090, close: 20110, volume: 1000 },
      { timestamp: NQ_MAY_1 + 900, open: 20110, high: 20130, low: 20100, close: 20125, volume: 1500 },
    ]);

    let bridgeCalled = false;
    const handler = createGetCandlesHandler({
      db,
      isConnected: () => true,
      request: async () => {
        bridgeCalled = true;
        throw new Error("bridge should not be called on cache hit");
      },
      ingestCandles: () => {
        throw new Error("ingestCandles should not be called on cache hit");
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
