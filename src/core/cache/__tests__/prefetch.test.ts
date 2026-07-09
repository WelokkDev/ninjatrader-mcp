import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../../db/schema.js";
import { PrefetchManager, type BridgeRequest } from "../prefetch.js";
import { CME_US_INDEX_FUTURES_ETH } from "../../sessions/templates.js";
import type { SessionDay } from "../../sessions/types.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

const TEMPLATE = CME_US_INDEX_FUTURES_ETH;
const D1: SessionDay = { label: "2026-05-04", startUnix: unix(2026, 5, 3, 22), endUnix: unix(2026, 5, 4, 21) };
const D2: SessionDay = { label: "2026-05-05", startUnix: unix(2026, 5, 4, 22), endUnix: unix(2026, 5, 5, 21) };
const D3: SessionDay = { label: "2026-05-06", startUnix: unix(2026, 5, 5, 22), endUnix: unix(2026, 5, 6, 21) };

// Scripted clock: starts well after D3's close so all fixture days are
// CLOSED, and advances 1s per read so ETA math has real durations.
function makeClock() {
  let t = (D3.endUnix + 3600) * 1000;
  return () => (t += 1000);
}

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function seed15m(db: Database.Database, day: SessionDay): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ', '15m', ?, 1, 2, 0.5, 1.5, 10)`,
  );
  for (let t = day.startUnix + 900; t <= day.endUnix; t += 900) stmt.run(t);
}

/** A request fake that "heals" like the real candles_response handler:
 *  when it resolves, the day's bars are already in the cache. */
function healingRequest(db: Database.Database): BridgeRequest {
  return async (_type, payload) => {
    const from = payload.from as number;
    const to = payload.to as number;
    seed15m(db, { label: "?", startUnix: from, endUnix: to });
    return {};
  };
}

/** Manually-released request fake for ordering/cancellation tests. */
function deferredRequest() {
  const calls: Array<{ payload: Record<string, unknown>; release: (heal?: () => void) => void; reject: (e: Error) => void }> = [];
  const request: BridgeRequest = (_type, payload) =>
    new Promise((resolve, reject) => {
      calls.push({
        payload,
        release: (heal) => {
          heal?.();
          resolve({});
        },
        reject,
      });
    });
  return { request, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function manager(db: Database.Database, request: BridgeRequest, connected = true) {
  return new PrefetchManager({
    db,
    isConnected: () => connected,
    request,
    nowMs: makeClock(),
  });
}

describe("PrefetchManager single-flight scheduling", () => {
  it("runs scheduled requests strictly one at a time", async () => {
    const db = memDb();
    const { request, calls } = deferredRequest();
    const m = manager(db, request);

    const p1 = m.scheduledRequest("request_candles", { tag: 1 });
    const p2 = m.scheduledRequest("request_candles", { tag: 2 });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.tag).toBe(1);

    calls[0].release();
    await p1;
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].payload.tag).toBe(2);
    calls[1].release();
    await p2;
  });

  it("foreground requests jump ahead of queued background days", async () => {
    const db = memDb();
    const { request, calls } = deferredRequest();
    const m = manager(db, request);

    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    await flush();
    expect(calls).toHaveLength(1); // D1 in flight, D2 queued

    const fg = m.scheduledRequest("request_candles", { tag: "fg" });
    calls[0].release(() => seed15m(db, D1));
    await flush();
    // Foreground beat the queued D2.
    expect(calls[1].payload.tag).toBe("fg");
    calls[1].release();
    await fg;
    await flush();
    expect(calls[2].payload.from).toBe(D2.startUnix);
    calls[2].release(() => seed15m(db, D2));
    await m.whenSettled(started.job.jobId);
  });
});

describe("PrefetchManager jobs", () => {
  it("fetches days, verifies the cache actually filled, and completes", async () => {
    const db = memDb();
    const m = manager(db, healingRequest(db));
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    expect(started.job.state).toBe("running");
    expect(started.job.daysTotal).toBe(2);
    expect(started.job.expectedBarsToFetch).toBe(184); // 92 × 2

    await m.whenSettled(started.job.jobId);
    const status = m.status(started.job.jobId);
    if ("error" in status) throw new Error(status.error);
    expect(status.job).toMatchObject({
      state: "completed",
      fetched: 2,
      failed: 0,
      pending: 0,
    });
    expect(status.job.finishedAt).not.toBeNull();
  });

  it("marks a day failed when the response lands but the cache stays empty", async () => {
    const db = memDb();
    const m = manager(db, async () => ({})); // resolves, heals nothing
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    await m.whenSettled(started.job.jobId);
    const status = m.status(started.job.jobId);
    if ("error" in status) throw new Error(status.error);
    expect(status.job.state).toBe("completed_with_failures");
    expect(status.job.failures[0].day).toBe("2026-05-04");
    expect(status.job.failures[0].error).toMatch(/still empty/);
  });

  it("isolates a rejected day while the rest succeed", async () => {
    const db = memDb();
    const heal = healingRequest(db);
    const m = manager(db, async (type, payload, timeoutMs) => {
      if (payload.from === D2.startUnix) throw new Error("boom");
      return heal(type, payload, timeoutMs);
    });
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2, D3], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    await m.whenSettled(started.job.jobId);
    const status = m.status(started.job.jobId);
    if ("error" in status) throw new Error(status.error);
    expect(status.job).toMatchObject({ state: "completed_with_failures", fetched: 2, failed: 1 });
    expect(status.job.failures).toEqual([{ day: "2026-05-05", error: "boom" }]);
  });

  it("skips already-complete days without issuing requests", async () => {
    const db = memDb();
    seed15m(db, D1);
    let requests = 0;
    const heal = healingRequest(db);
    const m = manager(db, (t, p, ms) => {
      requests++;
      return heal(t, p, ms);
    });
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    expect(started.job.alreadyComplete).toBe(1);
    await m.whenSettled(started.job.jobId);
    expect(requests).toBe(1);
  });

  it("completes instantly when every day is already cached", async () => {
    const db = memDb();
    seed15m(db, D1);
    const m = manager(db, healingRequest(db));
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    expect(started.job.state).toBe("completed");
    await m.whenSettled(started.job.jobId); // resolves immediately
  });

  it("refuses to start when NinjaTrader is disconnected", () => {
    const db = memDb();
    const m = manager(db, healingRequest(db), false);
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1], template: TEMPLATE });
    expect(started).toMatchObject({ error: expect.stringMatching(/not connected/i) });
  });

  it("guards against overlapping jobs on the same days", async () => {
    const db = memDb();
    const { request, calls } = deferredRequest();
    const m = manager(db, request);
    const a = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2], template: TEMPLATE });
    if ("error" in a) throw new Error(a.error);
    const b = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D2, D3], template: TEMPLATE });
    expect(b).toMatchObject({ error: expect.stringMatching(a.job.jobId) });
    // Drain so nothing leaks between tests.
    await flush();
    calls[0].release(() => seed15m(db, D1));
    await flush();
    calls[1].release(() => seed15m(db, D2));
    await m.whenSettled(a.job.jobId);
  });

  it("cancel stops pending days without touching the bridge again", async () => {
    const db = memDb();
    const { request, calls } = deferredRequest();
    const m = manager(db, request);
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2, D3], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    await flush();

    const cancelled = m.cancel(started.job.jobId);
    expect("error" in cancelled).toBe(false);

    calls[0].release(() => seed15m(db, D1)); // in-flight day completes honestly
    await m.whenSettled(started.job.jobId);

    expect(calls).toHaveLength(1); // D2/D3 never hit the bridge
    const status = m.status(started.job.jobId);
    if ("error" in status) throw new Error(status.error);
    expect(status.job).toMatchObject({ state: "cancelled", fetched: 1, cancelled: 2 });
  });

  it("reports an ETA once at least one day has been timed", async () => {
    const db = memDb();
    const { request, calls } = deferredRequest();
    const m = manager(db, request);
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    await flush();
    expect(started.job.etaSecs).toBeNull(); // nothing timed yet

    calls[0].release(() => seed15m(db, D1));
    await flush();
    const status = m.status(started.job.jobId);
    if ("error" in status) throw new Error(status.error);
    expect(status.job.etaSecs).toBeGreaterThan(0);

    calls[1].release(() => seed15m(db, D2));
    await m.whenSettled(started.job.jobId);
  });

  it("observes the early close of a declared untimed day and converges to fetched", async () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO session_calendar (template, date, kind, source)
       VALUES ('cme_us_index_futures_eth', '2026-05-04', 'modified', 'nt8')`,
    ).run();
    // NT8 returns a clean 13:00-EDT-trimmed session (76 x 15m).
    const trimmedEnd = D1.startUnix + 76 * 900;
    const m = manager(db, async (_type, payload) => {
      seed15m(db, {
        label: "trim",
        startUnix: payload.from as number,
        endUnix: trimmedEnd,
      });
      return {};
    });
    const started = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1], template: TEMPLATE });
    if ("error" in started) throw new Error(started.error);
    await m.whenSettled(started.job.jobId);

    const status = m.status(started.job.jobId);
    if ("error" in status) throw new Error(status.error);
    expect(status.job).toMatchObject({ state: "completed", fetched: 1, failed: 0 });

    const { loadCalendar } = await import("../../sessions/calendar.js");
    expect(loadCalendar(db, "cme_us_index_futures_eth").get("2026-05-04")).toMatchObject({
      closeTime: "13:00",
      source: "nt8-observed",
    });
  });

  it("never prunes a cancelled job while its day-tasks are still draining", async () => {
    const db = memDb();
    seed15m(db, D3); // for cheap instant-complete filler jobs
    const { request, calls } = deferredRequest();
    const m = manager(db, request);

    const a = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1, D2], template: TEMPLATE });
    if ("error" in a) throw new Error(a.error);
    await flush();
    m.cancel(a.job.jobId); // terminal-by-state, but D1 in flight / D2 queued

    // Flood the retention window with terminal jobs (each instant-complete).
    for (let i = 0; i < 25; i++) {
      const filler = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D3], template: TEMPLATE });
      if ("error" in filler) throw new Error(filler.error);
    }

    // The draining cancelled job must still be visible and awaitable.
    const status = m.status(a.job.jobId);
    expect("error" in status).toBe(false);

    calls[0].release(() => seed15m(db, D1));
    await m.whenSettled(a.job.jobId); // must not hang
    // Once settled the job becomes legitimately prunable (retention cap);
    // if still retained, it must read cancelled.
    const done = m.status(a.job.jobId);
    if (!("error" in done)) expect(done.job.state).toBe("cancelled");
  });

  it("status without a jobId lists jobs, newest first; unknown ids error", async () => {
    const db = memDb();
    const m = manager(db, healingRequest(db));
    const a = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D1], template: TEMPLATE });
    if ("error" in a) throw new Error(a.error);
    await m.whenSettled(a.job.jobId);
    const b = m.startJob({ symbol: "NQ", rawTimeframe: "15m", days: [D2], template: TEMPLATE });
    if ("error" in b) throw new Error(b.error);
    await m.whenSettled(b.job.jobId);

    const all = m.status();
    expect(all.jobs.map((j) => j.jobId)).toEqual([b.job.jobId, a.job.jobId]);

    expect(m.status("pf-nope")).toMatchObject({ error: expect.stringMatching(/unknown/i) });
  });
});
