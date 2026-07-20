import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { PrefetchManager, type BridgeRequest } from "../../core/cache/prefetch.js";
import { createPrefetchToolHandlers } from "../prefetch-candles.js";
import type { SessionDay } from "../../core/sessions/types.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

const D1: SessionDay = { label: "2026-05-04", startUnix: unix(2026, 5, 3, 22), endUnix: unix(2026, 5, 4, 21) };
const D2: SessionDay = { label: "2026-05-05", startUnix: unix(2026, 5, 4, 22), endUnix: unix(2026, 5, 5, 21) };

function makeClock() {
  let t = (D2.endUnix + 3600) * 1000;
  return () => (t += 1000);
}

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function seed15m(db: Database.Database, day: { startUnix: number; endUnix: number }): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ', '15m', ?, 1, 2, 0.5, 1.5, 10)`,
  );
  for (let t = day.startUnix + 900; t <= day.endUnix; t += 900) stmt.run(t);
}

function healingRequest(db: Database.Database): BridgeRequest {
  return async (_type, payload) => {
    seed15m(db, { startUnix: payload.from as number, endUnix: payload.to as number });
    return {};
  };
}

function harness(opts: { connected?: boolean } = {}) {
  const db = memDb();
  const manager = new PrefetchManager({
    db,
    isConnected: () => opts.connected ?? true,
    request: healingRequest(db),
    nowMs: makeClock(),
  });
  const handlers = createPrefetchToolHandlers({ manager, db });
  return { db, manager, handlers };
}

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe("prefetch_candles input validation", () => {
  it("rejects impossible dates via the round-trip guard", async () => {
    const { handlers } = harness();
    const res = await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-02-30", end: "2026-03-02" });
    expect(text(res)).toMatch(/impossible/);
  });

  it("rejects weekend labels with a pointer to resolve_session_days", async () => {
    const { handlers } = harness();
    const res = await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-05-02", end: "2026-05-05" });
    expect(text(res)).toMatch(/No session span/);
    expect(text(res)).toMatch(/resolve_session_days/);
  });

  it("rejects unsupported symbols and inverted ranges", async () => {
    const { handlers } = harness();
    expect(text(await handlers.start({ symbol: "ZZ", timeframe: "15m", start: "2026-05-04", end: "2026-05-05" }))).toMatch(/Unsupported symbol/);
    expect(text(await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-05-05", end: "2026-05-04" }))).toMatch(/not before/);
  });

  it("refuses to start while NinjaTrader is disconnected", async () => {
    const { handlers } = harness({ connected: false });
    const res = await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-05-04", end: "2026-05-05" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(text(res)).error).toMatch(/not connected/i);
  });

  it("rejects a market-holiday endpoint and excludes closed days mid-range", async () => {
    const { handlers } = harness();
    const holiday = await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-12-25", end: "2026-12-28" });
    expect(text(holiday)).toMatch(/market holiday/i);

    // Thu 12-24 .. Mon 12-28 with Fri 12-25 closed → two days planned.
    const started = JSON.parse(
      text(await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-12-24", end: "2026-12-28" })),
    );
    expect(started.daysTotal).toBe(2);
  });
});

describe("prefetch_candles lifecycle", () => {
  it("starts a job, reports the plan, and settles to completed", async () => {
    const { db, manager, handlers } = harness();
    seed15m(db, D1); // one of two days already cached

    const startRes = await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-05-04", end: "2026-05-05" });
    const started = JSON.parse(text(startRes));
    expect(started).toMatchObject({ daysTotal: 2, alreadyComplete: 1, state: "running" });
    expect(started.jobId).toMatch(/^pf-/);
    expect(started.hint).toMatch(/prefetch_status/);

    await manager.whenSettled(started.jobId);

    const statusRes = await handlers.status({ jobId: started.jobId });
    const status = JSON.parse(text(statusRes));
    expect(status).toMatchObject({ state: "completed", fetched: 1, failed: 0, pending: 0 });
  });

  it("lists all jobs when no jobId is given and errors on unknown ids", async () => {
    const { manager, handlers } = harness();
    const started = JSON.parse(
      text(await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-05-04", end: "2026-05-04" })),
    );
    await manager.whenSettled(started.jobId);

    const all = JSON.parse(text(await handlers.status({})));
    expect(all.jobs).toHaveLength(1);
    expect(all.jobs[0].jobId).toBe(started.jobId);

    expect(text(await handlers.status({ jobId: "pf-nope" }))).toMatch(/unknown/i);
    expect(text(await handlers.cancel({ jobId: "pf-nope" }))).toMatch(/unknown/i);
  });

  it("accepts the 15s raw stream and plans its dense geometry", async () => {
    const { manager, handlers } = harness();
    const started = JSON.parse(
      text(await handlers.start({ symbol: "NQ", timeframe: "15s", start: "2026-05-04", end: "2026-05-04" })),
    );
    expect(started).toMatchObject({
      timeframe: "15s",
      daysTotal: 1,
      expectedBarsToFetch: 5520,
    });
    await handlers.cancel({ jobId: started.jobId });
    await manager.whenSettled(started.jobId);
  });

  it("cancel reports the job snapshot", async () => {
    const { manager, handlers } = harness();
    const started = JSON.parse(
      text(await handlers.start({ symbol: "NQ", timeframe: "15m", start: "2026-05-04", end: "2026-05-05" })),
    );
    const cancelRes = JSON.parse(text(await handlers.cancel({ jobId: started.jobId })));
    expect(["cancelled", "completed", "completed_with_failures"]).toContain(cancelRes.state);
    await manager.whenSettled(started.jobId);
  });
});
