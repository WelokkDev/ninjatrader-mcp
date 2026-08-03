import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeSchema } from "../../db/schema.js";
import {
  LiveBarRecorder,
  longestMissingRunSecs,
  missingStampsBetween,
} from "../recorder.js";
import { GAP_MIN_SPAN_SECS } from "../heal.js";
import type { BarCloseMessage } from "../../bridge/protocol.js";

const unix = (y: number, mo1: number, d: number, h: number): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, 0, 0) / 1000);

// NQ session-day 2026-05-01 (Fri): Apr 30 18:00 EDT → May 1 17:00 EDT.
const DAY_START = unix(2026, 4, 30, 22);
const DAY_END = DAY_START + 82_800;
// Next session-day 2026-05-04 (Mon): opens Sunday May 3 18:00 EDT.
const SUNDAY_OPEN = unix(2026, 5, 3, 22);

const t5 = (i: number): number => DAY_START + i * 300; // canonical 5m stamps

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function bar(over: {
  ts: number;
  symbol?: string;
  timeframe?: string;
  seq?: number;
  backfill?: boolean;
}): BarCloseMessage {
  return {
    v: 1,
    type: "bar_close",
    symbol: over.symbol ?? "NQ",
    timeframe: over.timeframe ?? "5m",
    candle: {
      timestamp: over.ts,
      open: 100, high: 101, low: 99, close: 100.5, volume: 10,
    },
    ...(over.seq !== undefined ? { seq: over.seq } : {}),
    ...(over.backfill !== undefined ? { backfill: over.backfill } : {}),
  };
}

function makeRecorder(over: {
  onGap?: (g: { symbol: string; timeframe: string; fromTs: number; toTs: number }) => void;
  ringCapacity?: number;
  db?: Database.Database;
  dir?: string;
} = {}) {
  return new LiveBarRecorder({
    db: over.db ?? memDb(),
    dir: over.dir ?? mkdtempSync(join(tmpdir(), "live-rec-")),
    ringCapacity: over.ringCapacity ?? 500,
    nowMs: () => (t5(300) + 1) * 1000,
    onGap: over.onGap,
  });
}

describe("rings and counters", () => {
  it("keeps a per-(symbol,timeframe) ring with per-key eviction", () => {
    const rec = makeRecorder({ ringCapacity: 3 });
    for (let i = 1; i <= 4; i++) rec.record(bar({ ts: t5(i) }));
    rec.record(bar({ ts: t5(1), timeframe: "15m" }));
    const fiveMin = rec.recent({ symbol: "NQ", timeframe: "5m", limit: 10 });
    expect(fiveMin).toHaveLength(3);
    expect(fiveMin[0].timestamp).toBe(t5(4)); // newest first
    expect(rec.recent({ symbol: "NQ", timeframe: "15m", limit: 10 })).toHaveLength(1);
  });

  it("counts an exact-duplicate timestamp as dup and skips it", () => {
    const rec = makeRecorder();
    rec.record(bar({ ts: t5(1) }));
    rec.record(bar({ ts: t5(1) }));
    expect(rec.recent({ limit: 10 })).toHaveLength(1);
    expect(rec.status()[0].dupCount).toBe(1);
  });

  it("counts an older-than-last timestamp as out-of-order and skips it", () => {
    const rec = makeRecorder();
    rec.record(bar({ ts: t5(2) }));
    rec.record(bar({ ts: t5(1) }));
    expect(rec.recent({ limit: 10 })).toHaveLength(1);
    expect(rec.status()[0].outOfOrderCount).toBe(1);
  });
});

describe("gap detection (session-aware)", () => {
  it("contiguous grid stamps raise no gap", () => {
    const gaps: unknown[] = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    rec.record(bar({ ts: t5(1) }));
    rec.record(bar({ ts: t5(2) }));
    rec.record(bar({ ts: t5(3) }));
    expect(gaps).toHaveLength(0);
    expect(rec.status()[0].gapCount).toBe(0);
  });

  it("a skipped stamp mid-session raises a gap with the exact missing bounds", () => {
    const gaps: Array<{ fromTs: number; toTs: number }> = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    rec.record(bar({ ts: t5(1) }));
    rec.record(bar({ ts: t5(4) }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].fromTs).toBe(t5(2));
    expect(gaps[0].toTs).toBe(t5(3));
    expect(rec.status()[0].gapCount).toBe(1);
    expect(rec.status()[0].lastGapAt).not.toBeNull();
  });

  it("Friday close → Sunday open is contiguous (no weekend false gap)", () => {
    const gaps: unknown[] = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    rec.record(bar({ ts: DAY_END }));            // last 5m bar of Friday's day
    rec.record(bar({ ts: SUNDAY_OPEN + 300 }));  // first 5m bar of Monday's day
    expect(gaps).toHaveLength(0);
  });

  it("backfill bars never trigger gap detection but advance the cursor forward", () => {
    const gaps: unknown[] = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    rec.record(bar({ ts: t5(1) }));
    rec.record(bar({ ts: t5(5), backfill: true })); // stale catch-up burst
    rec.record(bar({ ts: t5(6) }));                 // next live bar: contiguous with t5(5)
    expect(gaps).toHaveLength(0);
    expect(rec.status()[0].lastReceivedTs).toBe(t5(6));
  });

  it("seq jumps are counted separately; seq resets are tolerated", () => {
    const gaps: unknown[] = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    rec.record(bar({ ts: t5(1), seq: 1 }));
    rec.record(bar({ ts: t5(2), seq: 5 })); // jump, but ts contiguous
    rec.record(bar({ ts: t5(3), seq: 1 })); // reset (AddOn re-subscribed)
    expect(rec.status()[0].seqJumps).toBe(1);
    expect(gaps).toHaveLength(0);
  });

  it("an unknown symbol records without crashing and without gap machinery", () => {
    const gaps: unknown[] = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    rec.record(bar({ ts: t5(1), symbol: "ZZZ" }));
    rec.record(bar({ ts: t5(9), symbol: "ZZZ" }));
    expect(rec.recent({ symbol: "ZZZ", limit: 10 })).toHaveLength(2);
    expect(gaps).toHaveLength(0);
  });
});

describe("longestMissingRunSecs", () => {
  it("measures a contiguous run, not the first-to-last extent", () => {
    // Two 3s clusters 176,400s apart (the weekend break): the extent is the
    // whole weekend, the longest actual run is 3 seconds.
    const missing = [100, 101, 102, 176_500, 176_501, 176_502];
    expect(missing[missing.length - 1] - missing[0] + 1).toBe(176_403); // old measure
    expect(longestMissingRunSecs(missing, 1)).toBe(3);
  });

  it("is period-aware and degenerate-safe", () => {
    expect(longestMissingRunSecs([300, 600, 900], 300)).toBe(900);
    expect(longestMissingRunSecs([300, 1200], 300)).toBe(300);
    expect(longestMissingRunSecs([], 1)).toBe(0);
    expect(longestMissingRunSecs([100], 0)).toBe(0); // unknown TF → no period
  });
});

describe("sparse-TF heal floor (GAP_MIN_SPAN_SECS)", () => {
  it("does NOT heal a few tickless 1s buckets either side of the weekend break", () => {
    const gaps: Array<{ fromTs: number; toTs: number }> = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    // Last 1s bar of Friday arrives 3s before the close, first of Monday 3s
    // after the reopen — 5 genuinely absent seconds, split by a ~49h break.
    rec.record(bar({ ts: DAY_END - 3, timeframe: "1s" }));
    rec.record(bar({ ts: SUNDAY_OPEN + 3, timeframe: "1s" }));

    // The gap is still SEEN (diagnostics stay honest)...
    expect(rec.status()[0].gapCount).toBe(1);
    // ...but no heal is requested: the longest real run is 3s, far under 180s.
    expect(gaps).toHaveLength(0);
    expect(GAP_MIN_SPAN_SECS["1s"]).toBe(180);
  });

  it("still heals a genuine contiguous 1s outage at or above the floor", () => {
    const gaps: Array<{ fromTs: number; toTs: number }> = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    const t = DAY_START + 3_600;
    rec.record(bar({ ts: t, timeframe: "1s" }));
    rec.record(bar({ ts: t + 201, timeframe: "1s" })); // 200s contiguous hole
    expect(gaps).toHaveLength(1);
    expect(gaps[0].fromTs).toBe(t + 1);
    expect(gaps[0].toTs).toBe(t + 200);
  });

  it("suppresses a sub-floor mid-session 1s lull but still counts it", () => {
    const gaps: unknown[] = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    const t = DAY_START + 3_600;
    rec.record(bar({ ts: t, timeframe: "1s" }));
    rec.record(bar({ ts: t + 60, timeframe: "1s" })); // 59s hole, under 180s
    expect(gaps).toHaveLength(0);
    expect(rec.status()[0].gapCount).toBe(1);
    expect(rec.status()[0].lastGapAt).not.toBeNull();
  });

  it("leaves floor-0 timeframes (5m) healing on any missing stamp", () => {
    const gaps: Array<{ fromTs: number; toTs: number }> = [];
    const rec = makeRecorder({ onGap: (g) => gaps.push(g) });
    expect(GAP_MIN_SPAN_SECS["5m"]).toBe(0);
    rec.record(bar({ ts: t5(1) }));
    rec.record(bar({ ts: t5(3) })); // one missing 5m stamp
    expect(gaps).toHaveLength(1);
    expect(gaps[0].fromTs).toBe(t5(2));
  });
});

describe("JSONL diagnostics", () => {
  it("names files by session-day label", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-rec-jsonl-"));
    const rec = makeRecorder({ dir });
    rec.record(bar({ ts: t5(1) }));
    const files = readdirSync(dir);
    expect(files).toEqual(["live-bars-NQ-5m-2026-05-01.jsonl"]);
  });
});

describe("missingStampsBetween", () => {
  it("returns the exact stamps strictly between prev and cur", () => {
    const db = memDb();
    expect(missingStampsBetween(db, "NQ", "5m", t5(1), t5(4))).toEqual([t5(2), t5(3)]);
  });

  it("bridges the weekend with no phantom stamps", () => {
    const db = memDb();
    expect(missingStampsBetween(db, "NQ", "5m", DAY_END, SUNDAY_OPEN + 300)).toEqual([]);
  });
});
