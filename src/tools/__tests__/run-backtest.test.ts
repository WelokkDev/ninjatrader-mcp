import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createRunBacktestHandler, type RunBacktestDeps } from "../run-backtest.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// Mon 2026-05-04 .. Tue 2026-05-05 session-days (EDT).
const D1_START = unix(2026, 5, 3, 22);
const D2_START = unix(2026, 5, 4, 22);
const D2_END = unix(2026, 5, 5, 21);

function seed5m(db: Database.Database, startUnix: number, skip = 0): void {
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
  );
  for (let i = 1; i <= 276 - skip; i++) stmt.run(startUnix + i * 300);
}

function harness(nowUnix?: number) {
  const db = new Database(":memory:");
  initializeSchema(db);
  const compose = vi.fn().mockReturnValue({ runId: "r1", barsEvaluated: 10 });
  const handler = createRunBacktestHandler({
    db,
    compose: compose as unknown as RunBacktestDeps["compose"],
    ...(nowUnix !== undefined && { now: () => nowUnix }),
  });
  return { db, compose, handler };
}

describe("run_backtest data preflight gate", () => {
  it("refuses to walk an incomplete range and never calls the engine", async () => {
    const { db, compose, handler } = harness();
    seed5m(db, D1_START); // D2 missing entirely
    const res = await handler({ symbol: "NQ", rangeStart: D1_START, rangeEnd: D2_END, lookbackDays: 0 });
    const text = res.content[0].text;
    expect(text).toMatch(/2026-05-05/);
    expect(text).toMatch(/preflight|incomplete/i);
    expect(text).toMatch(/get_candles|prefetch_candles/);
    expect(compose).not.toHaveBeenCalled();
  });

  it("walks a fully-cached range", async () => {
    const { db, compose, handler } = harness();
    seed5m(db, D1_START);
    seed5m(db, D2_START);
    const res = await handler({ symbol: "NQ", rangeStart: D1_START, rangeEnd: D2_END, lookbackDays: 0 });
    expect(compose).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ runId: "r1", barsEvaluated: 10 });
  });

  it("validates the SMA/HTF lookback window before rangeStart, not just the range", async () => {
    const { db, compose, handler } = harness();
    // Range day (Tue 05-05) fully cached; the single lookback day (Mon
    // 05-04) is missing entirely.
    seed5m(db, D2_START);
    const res = await handler({
      symbol: "NQ",
      rangeStart: D2_START,
      rangeEnd: D2_END,
      lookbackDays: 1,
    });
    const text = res.content[0].text;
    expect(text).toMatch(/2026-05-04/);
    expect(text).toMatch(/lookback/i);
    expect(compose).not.toHaveBeenCalled();

    seed5m(db, D1_START);
    const ok = await handler({
      symbol: "NQ",
      rangeStart: D2_START,
      rangeEnd: D2_END,
      lookbackDays: 1,
    });
    expect(compose).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ok.content[0].text)).toMatchObject({ runId: "r1" });
  });

  it("stamps a dataWarning when the range includes an in-progress session-day", async () => {
    // Pin "now" to mid-session of D2 so it classifies in-progress.
    const { db, compose, handler } = harness(D2_START + 3600);
    seed5m(db, D1_START);
    const res = await handler({
      symbol: "NQ",
      rangeStart: D1_START,
      rangeEnd: D2_END,
      lookbackDays: 0,
    });
    expect(compose).toHaveBeenCalledTimes(1);
    const out = JSON.parse(res.content[0].text);
    expect(out.dataWarning).toMatch(/in.progress/i);
    expect(out.dataWarning).toMatch(/2026-05-05/);
  });

  it("allowIncompleteData bypasses the gate but stamps a loud dataWarning", async () => {
    const { db, compose, handler } = harness();
    seed5m(db, D1_START);
    seed5m(db, D2_START, 4);
    const res = await handler({
      symbol: "NQ",
      rangeStart: D1_START,
      rangeEnd: D2_END,
      lookbackDays: 0,
      allowIncompleteData: true,
    });
    expect(compose).toHaveBeenCalledTimes(1);
    const out = JSON.parse(res.content[0].text);
    expect(out.dataWarning).toMatch(/2026-05-05/);
    expect(out.dataWarning).toMatch(/incomplete/i);
  });
});
