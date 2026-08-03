import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { loadCalendar } from "../core/sessions/calendar.js";
import {
  sessionDayContaining,
  sessionDaysOverlapping,
} from "../core/sessions/session-day.js";
import { expectedRawGrid } from "../core/cache/purge.js";
import type { Timeframe } from "../core/types.js";
import type { BarCloseMessage } from "../bridge/protocol.js";
import type { LiveTimeframe } from "./registry.js";
import { GAP_MIN_SPAN_SECS, TF_SECS } from "./heal.js";

export interface RecordedBar {
  receivedAtMs: number;
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  lagSeconds: number;
  seq?: number;
  backfill?: boolean;
}

export interface DetectedGap {
  symbol: string;
  timeframe: LiveTimeframe;
  fromTs: number; // first missing grid stamp (inclusive)
  toTs: number;   // last missing grid stamp (inclusive)
}

export interface LiveStreamStatus {
  symbol: string;
  timeframe: string;
  count: number;
  lastReceivedTs: number | null;
  lastLagSeconds: number | null;
  dupCount: number;
  outOfOrderCount: number;
  gapCount: number;
  lastGapAt: number | null; // unix seconds of detection
  seqJumps: number;
}

export interface RecorderDeps {
  db?: Database;
  dir?: string;
  ringCapacity?: number;
  nowMs?: () => number;
  onGap?: (gap: DetectedGap) => void;
}

interface StreamState extends LiveStreamStatus {
  ring: RecordedBar[];
  lastSeq: number | null;
}

/**
 * Expected raw-grid stamps strictly between `prev` and `cur`, across every
 * session-day the window overlaps — weekends/maintenance contribute nothing.
 * Shared by gap detection and the hello catch-up.
 */
export function missingStampsBetween(
  db: Database,
  symbol: string,
  timeframe: Exclude<Timeframe, "1d">,
  prev: number,
  cur: number,
): number[] {
  const config = getInstrumentConfig(symbol);
  const calendar = loadCalendar(db, config.session.name);
  const missing: number[] = [];
  for (const day of sessionDaysOverlapping(prev, cur, config.session, calendar)) {
    for (const ts of expectedRawGrid(day, timeframe, config.session, calendar)) {
      if (ts > prev && ts < cur) missing.push(ts);
    }
  }
  return missing.sort((a, b) => a - b);
}

/**
 * Longest run of CONSECUTIVE grid stamps in `missing`, in seconds (0 if
 * empty or period unknown). Deliberately not first-to-last extent: session
 * breaks contribute no stamps, so tickless buckets either side of a weekend
 * would otherwise measure as one ~176,000s span instead of the few seconds
 * actually missing.
 */
export function longestMissingRunSecs(missing: number[], periodSecs: number): number {
  if (missing.length === 0 || periodSecs <= 0) return 0;
  let longest = periodSecs;
  let run = periodSecs;
  for (let i = 1; i < missing.length; i++) {
    run = missing[i] - missing[i - 1] === periodSecs ? run + periodSecs : periodSecs;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * Per-stream live-feed diagnostics: rings, dup/seq counters, session-aware
 * gap detection, JSONL named by session-day.
 */
export class LiveBarRecorder {
  private readonly db: Database;
  private readonly dir: string;
  private readonly cap: number;
  private readonly nowMs: () => number;
  private readonly onGap?: (gap: DetectedGap) => void;
  private readonly streams = new Map<string, StreamState>();
  private dirReady = false;

  constructor(deps: RecorderDeps = {}) {
    this.db = deps.db ?? defaultDb;
    this.dir = deps.dir ?? join(process.cwd(), "data", "diagnostics");
    this.cap = deps.ringCapacity ?? 500;
    this.nowMs = deps.nowMs ?? ((): number => Date.now());
    this.onGap = deps.onGap;
  }

  record(msg: BarCloseMessage): void {
    try {
      const c = msg.candle;
      const receivedAtMs = this.nowMs();
      const key = `${msg.symbol}:${msg.timeframe}`;
      const state = this.streams.get(key) ?? this.freshState(msg.symbol, msg.timeframe);
      this.streams.set(key, state);

      const prevTs = state.lastReceivedTs;
      if (prevTs !== null && c.timestamp === prevTs) {
        state.dupCount++;
        return;
      }
      if (prevTs !== null && c.timestamp < prevTs) {
        state.outOfOrderCount++;
        return;
      }

      if (typeof msg.seq === "number") {
        if (state.lastSeq !== null && msg.seq > state.lastSeq + 1) state.seqJumps++;
        state.lastSeq = msg.seq;
      }

      // Gap check only for live (non-backfill) bars with a prior cursor.
      if (prevTs !== null && !msg.backfill) {
        this.detectGap(msg.symbol, msg.timeframe, prevTs, c.timestamp, state);
      }

      const bar: RecordedBar = {
        receivedAtMs,
        symbol: msg.symbol,
        timeframe: msg.timeframe,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        lagSeconds: Math.round(receivedAtMs / 1000 - c.timestamp),
        ...(typeof msg.seq === "number" ? { seq: msg.seq } : {}),
        ...(msg.backfill ? { backfill: true } : {}),
      };

      state.ring.push(bar);
      if (state.ring.length > this.cap) state.ring.shift();
      state.count++;
      state.lastReceivedTs = c.timestamp;
      state.lastLagSeconds = bar.lagSeconds;

      this.appendJsonl(bar);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[live-recorder] record failed: ${m}`);
    }
  }

  recent(filter: { symbol?: string; timeframe?: string; limit?: number } = {}): RecordedBar[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 20, this.cap));
    const bars: RecordedBar[] = [];
    for (const state of this.streams.values()) {
      if (filter.symbol && state.symbol !== filter.symbol) continue;
      if (filter.timeframe && state.timeframe !== filter.timeframe) continue;
      bars.push(...state.ring);
    }
    bars.sort((a, b) => a.timestamp - b.timestamp);
    return bars.slice(-limit).reverse(); // newest first
  }

  status(): LiveStreamStatus[] {
    return [...this.streams.values()].map((s) => ({
      symbol: s.symbol,
      timeframe: s.timeframe,
      count: s.count,
      lastReceivedTs: s.lastReceivedTs,
      lastLagSeconds: s.lastLagSeconds,
      dupCount: s.dupCount,
      outOfOrderCount: s.outOfOrderCount,
      gapCount: s.gapCount,
      lastGapAt: s.lastGapAt,
      seqJumps: s.seqJumps,
    }));
  }

  private detectGap(
    symbol: string,
    timeframe: string,
    prevTs: number,
    curTs: number,
    state: StreamState,
  ): void {
    let missing: number[];
    try {
      missing = missingStampsBetween(
        this.db,
        symbol,
        timeframe as Exclude<Timeframe, "1d">,
        prevTs,
        curTs,
      );
    } catch {
      // Unknown symbol/template — diagnostics keep flowing without session math.
      return;
    }
    if (missing.length === 0) return;
    // A no-tick lull on a sparse TF isn't a gap (GAP_MIN_SPAN_SECS) — still
    // counted, but healed only if the longest contiguous run clears the floor.
    const tf = timeframe as LiveTimeframe;
    const floor = GAP_MIN_SPAN_SECS[tf] ?? 0;
    state.gapCount++;
    state.lastGapAt = Math.floor(this.nowMs() / 1000);
    if (floor > 0 && longestMissingRunSecs(missing, TF_SECS[tf] ?? 0) < floor) return;
    if (this.onGap) {
      try {
        this.onGap({
          symbol,
          timeframe: timeframe as LiveTimeframe,
          fromTs: missing[0],
          toTs: missing[missing.length - 1],
        });
      } catch (err) {
        console.error("[live-recorder] onGap handler error:", err);
      }
    }
  }

  private appendJsonl(bar: RecordedBar): void {
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
      }
      const file = join(
        this.dir,
        `live-bars-${bar.symbol}-${bar.timeframe}-${this.sessionDayLabel(bar)}.jsonl`,
      );
      appendFileSync(file, `${JSON.stringify(bar)}\n`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[live-recorder] jsonl append failed: ${m}`);
    }
  }

  private sessionDayLabel(bar: RecordedBar): string {
    try {
      const config = getInstrumentConfig(bar.symbol);
      const calendar = loadCalendar(this.db, config.session.name);
      const day = sessionDayContaining(bar.timestamp, config.session, calendar);
      if (day) return day.label;
    } catch {
      // fall through
    }
    return "nosession";
  }

  private freshState(symbol: string, timeframe: string): StreamState {
    return {
      symbol,
      timeframe,
      count: 0,
      lastReceivedTs: null,
      lastLagSeconds: null,
      dupCount: 0,
      outOfOrderCount: 0,
      gapCount: 0,
      lastGapAt: null,
      seqJumps: 0,
      ring: [],
      lastSeq: null,
    };
  }
}
