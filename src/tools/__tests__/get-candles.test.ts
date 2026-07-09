import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createGetCandlesHandler } from "../get-candles.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-day 2026-05-01 (Fri): Apr 30 18:00 EDT → May 1 17:00 EDT.
const DAY_START = unix(2026, 4, 30, 22);

// A full 23h session-day of 5m bars: 276 close-stamps at start + i*300.
function seedSessionDay(db: Database.Database, symbol: string, startUnix: number): void {
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, '5m', ?, 1, 2, 0.5, 1.5, 10)`,
  );
  for (let i = 1; i <= 276; i++) {
    stmt.run(symbol, startUnix + i * 300);
  }
}

function harness(opts: { connected?: boolean } = {}) {
  const db = new Database(":memory:");
  initializeSchema(db);
  const request = vi.fn();
  const handler = createGetCandlesHandler({
    db,
    isConnected: () => opts.connected ?? false,
    request,
  });
  return { db, handler, request };
}

async function call(
  handler: ReturnType<typeof createGetCandlesHandler>,
  args: Partial<Parameters<ReturnType<typeof createGetCandlesHandler>>[0]>,
) {
  const res = await handler({
    symbol: "NQ",
    timeframe: "5m",
    start: "2026-05-01",
    end: "2026-05-01",
    ...args,
  } as Parameters<ReturnType<typeof createGetCandlesHandler>>[0]);
  return res.content[0].text;
}

describe("get_candles fail-closed truncation gate", () => {
  it("returns a fully-cached day under the limit with matched reported", async () => {
    const { db, handler } = harness();
    seedSessionDay(db, "NQ", DAY_START);
    const out = JSON.parse(await call(handler, {}));
    expect(out.count).toBe(276);
    expect(out.candles).toHaveLength(276);
    expect(out.matched).toBe(276);
    expect(out.warning).toBeUndefined();
    expect(out.validation).toMatchObject({ ok: 1, mismatch: 0 });
    expect(out.data_complete).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it("fails closed on a range whose geometry exceeds the limit, before any fetch", async () => {
    const { handler, request } = harness({ connected: true });
    // Mon 2026-05-04 .. Fri 2026-05-08 at 5m = 5 × 276 = 1380 expected bars.
    const text = await call(handler, { start: "2026-05-04", end: "2026-05-08" });
    expect(text).toMatch(/1380/);
    expect(text).toMatch(/500/);
    expect(text).toMatch(/limit/i);
    // Fail-closed: the error carries no candle payload at all.
    expect(text).not.toMatch(/"candles"/);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not flag a range holding exactly `limit` bars", async () => {
    const { db, handler } = harness();
    seedSessionDay(db, "NQ", DAY_START);
    const out = JSON.parse(await call(handler, { limit: 276 }));
    expect(out.count).toBe(276);
    expect(out.matched).toBe(276);
    expect(out.warning).toBeUndefined();
  });

  it("honors an explicit larger limit as the escape hatch", async () => {
    const { handler } = harness();
    // Unseeded + disconnected: gate passes with limit >= matched, and the
    // normal disconnected warning path still runs.
    const out = JSON.parse(
      await call(handler, { start: "2026-05-04", end: "2026-05-08", limit: 1380 }),
    );
    expect(out.matched).toBe(1380);
    expect(out.count).toBe(0);
    expect(out.warning).toMatch(/not connected/i);
    expect(out.data_complete).toBe(false);
  });
});

describe("get_candles 15s raw stream", () => {
  it("computes 15s geometry and fails closed at the default limit", async () => {
    const { handler, request } = harness({ connected: true });
    const text = await call(handler, { timeframe: "15s" });
    expect(text).toMatch(/5520/);
    expect(text).toMatch(/over the limit 500/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("get_candles calendar + trust addenda", () => {
  it("rejects a market-holiday endpoint with holiday guidance", async () => {
    const { handler } = harness();
    // 2026-12-25 is a Friday — a valid weekday label that the bootstrap
    // calendar declares fully closed.
    const text = await call(handler, { start: "2026-12-25", end: "2026-12-25" });
    expect(text).toMatch(/market holiday/i);
    expect(text).toMatch(/Christmas/);
  });

  it("serves a fully-cached early-close day as complete offline (no refetch loop)", async () => {
    const { db, handler } = harness();
    // Presidents Day 2026-02-16: bootstrap declares 13:00 ET close.
    // Session = Sun 15th 18:00 EST → Mon 16th 13:00 EST = 68,400s = 228 x 5m.
    const start = unix(2026, 2, 15, 23);
    const stmt = db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
    );
    for (let i = 1; i <= 228; i++) stmt.run(start + i * 300);

    const out = JSON.parse(await call(handler, { start: "2026-02-16", end: "2026-02-16" }));
    expect(out.count).toBe(228);
    expect(out.matched).toBe(228);
    expect(out.validation).toMatchObject({ ok: 1, mismatch: 0 });
    expect(out.warning).toBeUndefined();
    expect(out.data_complete).toBe(true);
  });

  it("flags truncation loudly when actual rows exceed the returned set", async () => {
    // Connected with a no-op bridge: the orphan makes the day classify
    // partial (triggering a fetch that "succeeds" without changing rows),
    // isolating the truncation warning from the fill-failure warning.
    const { db, handler } = harness({ connected: true });
    seedSessionDay(db, "NQ", DAY_START);
    // One orphan row at a non-canonical stamp pushes actual rows past the
    // explicit limit — the belt-and-suspenders LIMIT clips silently without
    // the post-SELECT count check.
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(DAY_START + 450);

    const out = JSON.parse(await call(handler, { limit: 276 }));
    expect(out.count).toBe(276);
    expect(out.truncated).toBe(true);
    expect(out.warning).toMatch(/truncat/i);
    expect(out.data_complete).toBe(false);
  });
});
