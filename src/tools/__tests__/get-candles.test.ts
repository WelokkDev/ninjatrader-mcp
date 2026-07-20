import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createGetCandlesHandler } from "../get-candles.js";
import { createCandlesResponseHandler, ingestCandles } from "../../bridge/ingest.js";

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
    // The refusal must route uncached ranges to the background job, not
    // coach a bigger limit into a doomed inline mega-fill.
    expect(text).toMatch(/prefetch_candles/);
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

describe("get_candles inline cold-work guard", () => {
  // Mon 2026-05-04 .. Fri 2026-05-22 = 15 session-days (3 Mon–Fri weeks).
  const WEEK3 = { start: "2026-05-04", end: "2026-05-22", limit: 5000 };
  const WEEK3_LABELS: Array<[number, number]> = [
    [5, 4], [5, 5], [5, 6], [5, 7], [5, 8],
    [5, 11], [5, 12], [5, 13], [5, 14], [5, 15],
    [5, 18], [5, 19], [5, 20], [5, 21], [5, 22],
  ];

  it("refuses an inline fill when the cold session-day count exceeds the threshold", async () => {
    const { handler, request } = harness({ connected: true });
    const text = await call(handler, WEEK3);
    expect(text).toMatch(/15 session-day/);
    expect(text).toMatch(/prefetch_candles/);
    expect(text).not.toMatch(/"candles"/);
    expect(request).not.toHaveBeenCalled();
  });

  it("fetches inline at or under the threshold", async () => {
    const { handler, request } = harness({ connected: true });
    request.mockResolvedValue(undefined);
    const out = JSON.parse(
      await call(handler, { start: "2026-05-04", end: "2026-05-05", limit: 600 }),
    );
    expect(request).toHaveBeenCalledTimes(2); // one window per cold day
    expect(out.matched).toBe(552);
  });

  it("does not trip on a big range that is already fully cached", async () => {
    const { db, handler, request } = harness({ connected: true });
    // Session-day D starts at 18:00 ET (22:00 UTC in May) the previous day.
    for (const [mo, d] of WEEK3_LABELS) seedSessionDay(db, "NQ", unix(2026, mo, d - 1, 22));
    const out = JSON.parse(await call(handler, WEEK3));
    expect(out.count).toBe(15 * 276);
    expect(out.data_complete).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the disconnected warning path for big cold ranges (no inline work to guard)", async () => {
    const { handler } = harness();
    const out = JSON.parse(await call(handler, WEEK3));
    expect(out.count).toBe(0);
    expect(out.warning).toMatch(/not connected/i);
    expect(out.data_complete).toBe(false);
  });
});

describe("get_candles 15s raw stream", () => {
  it("computes 15s geometry and fails closed at the default limit", async () => {
    const { handler, request } = harness({ connected: true });
    const text = await call(handler, { timeframe: "15s" });
    expect(JSON.parse(text).error).toMatch(/over the limit 500/);
    expect(text).toMatch(/5520/);
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

  it("converges a raw orphan through a real refetch: day-refill replaces the day", async () => {
    const { db, handler, request } = harness({ connected: true });
    seedSessionDay(db, "NQ", DAY_START);
    // Off-grid 5m orphan makes the closed day classify partial.
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(DAY_START + 450);
    // Wire the bridge like production: the fetch produces a candles_response
    // that the global ingest handler persists (day-refill).
    const respond = createCandlesResponseHandler(db);
    request.mockImplementation(async () => {
      const candles = [];
      for (let i = 1; i <= 276; i++) {
        candles.push({ timestamp: DAY_START + i * 300, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
      }
      respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "5m", candles });
      return {};
    });

    const out = JSON.parse(await call(handler, {}));
    expect(out.count).toBe(276);
    expect(out.truncated).toBe(false);
    expect(out.validation).toMatchObject({ ok: 1, mismatch: 0 });
    expect(out.warning).toBeUndefined();
    expect(out.data_complete).toBe(true);
  });

  it("flags truncation loudly when actual rows exceed the returned set", async () => {
    // An IN-PROGRESS day: the post-fetch reconcile never purges an open
    // session, so an in-window orphan outlives the (no-op) fetch and trips
    // the LIMIT clip. (A closed connected day now converges instead — the
    // orphan dies before the SELECT — which is the convergence contract.)
    vi.useFakeTimers();
    vi.setSystemTime(new Date((DAY_START + 82_000) * 1000)); // before the 17:00 close
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("recomputes derived rows after a zero-bar refetch purges junk 15m (no stale OHLC survives)", async () => {
    const { db, handler, request } = harness({ connected: true });
    // Clean closed day, then a mis-stamped junk 15m bar arrives via live
    // append (append mode never screens): the day's derived rows are
    // recomputed over the junk — canonical stamps, corrupted OHLCV.
    const respond = createCandlesResponseHandler(db);
    respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "15m", candles: bars15m(1, 92) });
    ingestCandles(
      "NQ", "15m",
      [{ timestamp: DAY_START + 450, open: 1e6, high: 2e6, low: 1, close: 1e6, volume: 1 }],
      db,
      { mode: "append" },
    );
    // NT8 has nothing more for the day: the refetch returns zero bars, so
    // only the requester-side reconcile removes the junk 15m row — and it
    // must also re-derive, or the contaminated 1h open is served as trusted.
    request.mockImplementation(async () => {
      respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "15m", candles: [] });
      return {};
    });

    const out = JSON.parse(await call(handler, { timeframe: "1h" }));
    expect(out.count).toBe(23);
    expect(out.candles[0].open).toBe(101); // bar 1's open, not the junk 1e6
    expect(out.data_complete).toBe(true);
  });

  it("converges stranded derived junk when the zero-bar reconcile empties a day's 15m", async () => {
    const { db, handler, request } = harness({ connected: true });
    // Junk-only day: one off-grid 15m row appended live; derived rows were
    // recomputed from it (junk over junk).
    ingestCandles(
      "NQ", "15m",
      [{ timestamp: DAY_START + 450, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      db,
      { mode: "append" },
    );
    const respond = createCandlesResponseHandler(db);
    request.mockImplementation(async () => {
      respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "15m", candles: [] });
      return {};
    });

    const out = JSON.parse(await call(handler, { timeframe: "1h" }));
    // The 15m purge must take the day's derived junk with it (derived is a
    // pure function of the day's 15m — here, of nothing).
    expect(out.count).toBe(0);
    expect(out.data_complete).toBe(false);
  });

  it("counts ALL cached between-window rows in range, not just those inside the LIMIT clip", async () => {
    const { db, handler } = harness(); // disconnected — both days fully cached
    seedSessionDay(db, "NQ", unix(2026, 5, 3, 22)); // 2026-05-04
    seedSessionDay(db, "NQ", unix(2026, 5, 4, 22)); // 2026-05-05
    const ins = db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
    );
    // 300 residue rows in the maintenance gap — more than fit in the LIMIT
    // alongside day 1, so some never reach the row set at all.
    const gapStart = unix(2026, 5, 4, 21);
    for (let i = 1; i <= 300; i++) ins.run(gapStart + i * 10);

    const out = JSON.parse(
      await call(handler, { start: "2026-05-04", end: "2026-05-05", limit: 552 }),
    );
    expect(out.inter_session_rows_excluded).toBe(300);
    // Residue occupied LIMIT slots and pushed canonical day-2 rows out —
    // loud, fail-closed.
    expect(out.truncated).toBe(true);
    expect(out.data_complete).toBe(false);
  });

  it("excludes rows stranded between session-days and keeps the response trusted", async () => {
    const { db, handler } = harness(); // disconnected — both days fully cached
    seedSessionDay(db, "NQ", unix(2026, 5, 3, 22)); // 2026-05-04
    seedSessionDay(db, "NQ", unix(2026, 5, 4, 22)); // 2026-05-05
    // Legacy residue in the maintenance break: Mon 17:30 ET, strictly
    // between day 05-04's close and day 05-05's open — in no session-day
    // window, so no validator or purge ever sees it.
    const phantom = unix(2026, 5, 4, 21) + 1800;
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(phantom);

    const out = JSON.parse(
      await call(handler, { start: "2026-05-04", end: "2026-05-05", limit: 600 }),
    );
    expect(out.candles.map((c: { timestamp: number }) => c.timestamp)).not.toContain(phantom);
    expect(out.count).toBe(552);
    expect(out.inter_session_rows_excluded).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.validation).toMatchObject({ ok: 2, mismatch: 0 });
    expect(out.data_complete).toBe(true);
  });

  it("converges a junk-only day on a zero-bar refetch (post-fetch reconcile)", async () => {
    const { db, handler, request } = harness({ connected: true });
    // A closed day holding ONLY an off-grid row — NT8 has nothing for it
    // (provider-gap day). The empty response never reaches ingest's purge,
    // so only the requester-side reconcile can converge the day.
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '5m', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(DAY_START + 450);
    const respond = createCandlesResponseHandler(db);
    request.mockImplementation(async () => {
      respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "5m", candles: [] });
      return {};
    });

    const out = JSON.parse(await call(handler, {}));
    // The junk is gone and the day is honest-empty (loud, but stable).
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM candles WHERE symbol='NQ' AND timeframe='5m'`).get(),
    ).toEqual({ c: 0 });
    expect(out.count).toBe(0);
    expect(out.data_complete).toBe(false);
  });
});

// Session-day 2026-05-01 15m helpers for the derived-TF read-path tests.
function bars15m(fromIdx: number, toIdx: number, startUnix = DAY_START) {
  const out = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    out.push({
      timestamp: startUnix + i * 900,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10,
    });
  }
  return out;
}

function wireBridge15m(
  db: Database.Database,
  request: ReturnType<typeof vi.fn>,
  candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>,
) {
  const respond = createCandlesResponseHandler(db);
  request.mockImplementation(async () => {
    respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "15m", candles });
    return {};
  });
}

describe("get_candles derived-TF read path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the mid-session forming derived bar partial:true and reports partial_bars", async () => {
    vi.useFakeTimers();
    // 20:35 ET inside session-day 2026-05-01 — 15m data exists through 20:30.
    vi.setSystemTime(new Date((DAY_START + 10 * 900 + 300) * 1000));
    const { db, handler, request } = harness({ connected: true });
    wireBridge15m(db, request, bars15m(1, 10));

    const out = JSON.parse(await call(handler, { timeframe: "1h" }));
    expect(out.count).toBe(3); // 19:00, 20:00, 20:30(forming)
    expect(out.candles[0].partial).toBeUndefined();
    expect(out.candles[1].partial).toBeUndefined();
    expect(out.candles[2].partial).toBe(true);
    expect(out.partial_bars).toBe(1);
    // In-progress day never falsifies the trust bit — the flag makes that safe.
    expect(out.data_complete).toBe(true);
    expect(out.validation).toMatchObject({ in_progress: 1, mismatch: 0 });
  });

  it("never flags a legitimate early-close stub bar (Presidents Day 13:00 close)", async () => {
    const { db, handler, request } = harness({ connected: true });
    // Presidents Day session: Sun Feb 15 18:00 EST → Mon Feb 16 13:00 EST = 76 15m bars.
    const pdStart = unix(2026, 2, 15, 23);
    wireBridge15m(db, request, bars15m(1, 76, pdStart));

    const out = JSON.parse(
      await call(handler, { timeframe: "2h", start: "2026-02-16", end: "2026-02-16" }),
    );
    // 68,400s / 7200 = 9 full 2h bars + the 13:00 stub.
    expect(out.count).toBe(10);
    expect(out.candles.every((c: { partial?: boolean }) => c.partial === undefined)).toBe(true);
    expect(out.partial_bars).toBeUndefined();
    expect(out.validation).toMatchObject({ ok: 1, mismatch: 0 });
    expect(out.data_complete).toBe(true);
  });

  it("heals stale derived orphans on a raw-complete closed day without the bridge", async () => {
    const { db, handler } = harness(); // disconnected — heal must be bridge-free
    // Raw-complete day with converged derived rows…
    const respond = createCandlesResponseHandler(db);
    respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "15m", candles: bars15m(1, 92) });
    // …plus a stale mid-session orphan.
    db.prepare(
      `INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
       VALUES ('NQ', '1h', ?, 1, 2, 0.5, 1.5, 10)`,
    ).run(DAY_START + 9000);

    const out = JSON.parse(await call(handler, { timeframe: "1h" }));
    expect(out.count).toBe(23);
    expect(out.candles.map((c: { timestamp: number }) => c.timestamp)).not.toContain(DAY_START + 9000);
    expect(out.validation).toMatchObject({ ok: 1, mismatch: 0 });
    expect(out.data_complete).toBe(true);
  });

  it("does not flap the derived heal on a permanently gapped day (no-op recompute is skipped)", async () => {
    const { db, handler } = harness(); // disconnected — nothing can backfill the gap
    // Closed day whose 15m gap tail-clips the first 1h bucket (bar 4 missing):
    // the recompute deterministically reproduces the off-grid derived row.
    const respond = createCandlesResponseHandler(db);
    respond({
      v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "15m",
      candles: [...bars15m(1, 3), ...bars15m(5, 92)],
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out1 = JSON.parse(await call(handler, { timeframe: "1h" }));
    const out2 = JSON.parse(await call(handler, { timeframe: "1h" }));
    const healLogs = errSpy.mock.calls.filter((c) => String(c[0]).includes("re-derived"));
    errSpy.mockRestore();
    // Recompute would reproduce the same rows — no write churn, no false log…
    expect(healLogs).toHaveLength(0);
    // …and the day stays loud on both reads.
    expect(out1.validation.mismatch).toBe(1);
    expect(out2.validation.mismatch).toBe(1);
  });

  it("re-derives a closed day whose derived rows are missing over complete 15m backing", async () => {
    const { db, handler } = harness(); // disconnected — the heal must be bridge-free
    const respond = createCandlesResponseHandler(db);
    respond({ v: 1, id: "x", type: "candles_response", symbol: "NQ", timeframe: "15m", candles: bars15m(1, 92) });
    // An external writer stripped the 1h rows; the 15m backing is complete,
    // so fill and prefetch both classify the day complete and skip it —
    // only the read-time re-derive can converge it.
    db.prepare(`DELETE FROM candles WHERE symbol = 'NQ' AND timeframe = '1h'`).run();

    const out = JSON.parse(await call(handler, { timeframe: "1h" }));
    expect(out.count).toBe(23);
    expect(out.validation).toMatchObject({ ok: 1, mismatch: 0 });
    expect(out.data_complete).toBe(true);
  });

  it("flags a canonical derived bar over a holed 15m bucket in the in-progress session", async () => {
    vi.useFakeTimers();
    // 20:35 ET inside session-day 2026-05-01 — 15m data exists through 20:30.
    vi.setSystemTime(new Date((DAY_START + 10 * 900 + 300) * 1000));
    const { db, handler, request } = harness({ connected: true });
    // 15m bar 3 (interior to the first 1h bucket) is missing; the boundary
    // bar 4 survives, so the 19:00 1h bar keeps a canonical stamp while
    // aggregating only 3 of its 4 constituents.
    wireBridge15m(db, request, [...bars15m(1, 2), ...bars15m(4, 10)]);

    const out = JSON.parse(await call(handler, { timeframe: "1h" }));
    expect(out.count).toBe(3);
    expect(out.candles[0].partial).toBe(true); // canonical stamp, holed backing
    expect(out.candles[1].partial).toBeUndefined(); // complete 20:00 bucket
    expect(out.candles[2].partial).toBe(true); // forming 20:30 bar
    expect(out.partial_bars).toBe(2);
    // In-progress day: the flag carries the distrust, not the trust bit.
    expect(out.data_complete).toBe(true);
  });

  it("does not duplicate empty-day issues into raw_15m on a cold disconnected derived read", async () => {
    const { handler } = harness(); // disconnected, cache empty
    const out = JSON.parse(await call(handler, { timeframe: "4h" }));
    expect(out.validation.mismatch).toBe(1); // the day is already loud at 4h
    expect(out.warning).toMatch(/not connected/i);
    expect(out.validation.raw_15m).toBeUndefined();
  });

  it("surfaces incomplete 15m backing on a derived read even when derived stamps are canonical", async () => {
    const { db, handler, request } = harness({ connected: true });
    // Interior 15m gap (bars 2..8 missing) but every 4h bucket keeps its last
    // bar → all 4h stamps canonical, yet the first bar is built from a
    // fraction of its bucket.
    wireBridge15m(db, request, [...bars15m(1, 1), ...bars15m(9, 92)]);

    const out = JSON.parse(await call(handler, { timeframe: "4h" }));
    expect(out.count).toBe(6);
    expect(out.validation).toMatchObject({ ok: 1, mismatch: 0 }); // 4h stamps canonical
    expect(out.validation.raw_15m.mismatch).toBe(1); // …but the backing is holed
    expect(out.warning).toMatch(/15m/);
    expect(out.data_complete).toBe(false);
  });
});
