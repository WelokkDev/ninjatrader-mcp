// Public, strategy-neutral fill simulator. Walks an ALREADY-ENTERED trade forward bar by bar and resolves its exit. 
// Nothing here encodes the strategy — it consumes the neutral OpenTrade / FillConfig / ExitReason contract from ./types.js, 
// so both the backtest walker (over historical bars) and a future live exit-monitor (over incoming bars) can share it.
//
// Resolution order per bar: move the stop per the management model (favorable / ratchet, using only info confirmed at prior closes), 
// update MFE, then check a gap-through-on-open, then an intrabar touch (both-touched resolved by FillConfig.bothTouchedRule), then the bars-in-trade timeout.
//
// bars[0] is the ENTRY bar: the trade is already filled at OpenTrade.entryPrice (= that bar's open), so no gap check applies to it,
// we only watch its high/low for a same-bar exit. Subsequent bars get the full gap-then-intrabar treatment. 
// This is the deliberate, documented intrabar convention (the stop for bar i uses information confirmed at closes ≤ i−1,
// a future 15s layer would sharpen wick-vs-extreme sequencing here).

import type { Candle } from "../types.js";
import type {
  ExitReason,
  FillConfig,
  ManagementMode,
  OpenTrade,
  TradeDirection,
} from "./types.js";

export interface FillResult {
  exitTs: number;
  exitPrice: number;
  exitReason: ExitReason; // never "manual" in a backtest
  barsInTrade: number; // bars from the entry bar (inclusive) to the exit bar
  mfe: number; // max favorable excursion, in R
  ambiguousBars: number; // bars that touched BOTH stop and target (0 or 1 — the exit bar)
}

// Per-bar context handed to a management model. `entryStop` is the initial stop and defines 1R; `bars` is the same window passed to simulateFill.
export interface ManageCtx {
  bars: Candle[];
  direction: TradeDirection;
  entryPrice: number;
  entryStop: number;
  targetPrice: number;
}

export interface ManagementModel {
  readonly mode: ManagementMode;
  // The DESIRED stop for bar i, using ONLY information confirmed at closes ≤ i−1 (no look-ahead). 
  // simulateFill then ratchets it favorable-only, so a model never has to track the running stop itself.
  stopForBar(i: number, prevStop: number, ctx: ManageCtx): number;
}

// "fixed" — the entry stop never moves. The control / conservative floor.
export const fixedManagement: ManagementModel = {
  mode: "fixed",
  stopForBar: (_i, _prevStop, ctx) => ctx.entryStop,
};

// "trailing" — a structure-agnostic ATR(period) chandelier from the high-water mark. 
// The AGGRESSIVE comparator: it may move the stop to/through breakeven
// (that is the point of the contrast). Included to quantify, not to deploy.
export class ChandelierTrail implements ManagementModel {
  readonly mode: ManagementMode = "trailing";
  constructor(
    private readonly k = 3,
    private readonly atrPeriod = 14,
  ) {}
  stopForBar(i: number, prevStop: number, ctx: ManageCtx): number {
    if (i < 1) return ctx.entryStop;
    const confirmed = ctx.bars.slice(0, i); // bars [0 .. i−1]
    const atr = wilderAtr(confirmed, this.atrPeriod);
    if (atr === null) return prevStop;
    if (ctx.direction === "long") {
      let hwm = -Infinity;
      for (const b of confirmed) if (b.high > hwm) hwm = b.high;
      return hwm - this.k * atr;
    }
    let lwm = Infinity;
    for (const b of confirmed) if (b.low < lwm) lwm = b.low;
    return lwm + this.k * atr;
  }
}

// "constrained" — the conservative trail. The private walker precomputes a
// per-bar stop candidate under its own (private) management rules and passes
// it in; this model just reads it. Where no move is warranted the candidate
// equals the entry stop, so the favorable-only ratchet simply holds the
// running stop.
export class ConstrainedTrail implements ManagementModel {
  readonly mode: ManagementMode = "constrained";
  constructor(private readonly candidates: readonly number[]) {}
  stopForBar(i: number, _prevStop: number, ctx: ManageCtx): number {
    const c = this.candidates[i];
    return c === undefined || !Number.isFinite(c) ? ctx.entryStop : c;
  }
}

export type BracketViolation = "past-stop" | "past-target";

// A tradable bracket has the entry strictly between stop and target; returns
// the violated side, or null when strictly inside.
export function bracketViolation(
  direction: TradeDirection,
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
): BracketViolation | null {
  if (direction === "long") {
    if (entryPrice <= stopPrice) return "past-stop";
    if (entryPrice >= targetPrice) return "past-target";
  } else {
    if (entryPrice >= stopPrice) return "past-stop";
    if (entryPrice <= targetPrice) return "past-target";
  }
  return null;
}

// Walk the trade forward. Returns null if it never resolves within the supplied
// window (the walker force-closes at the last bar). bars must be ascending and start at the entry bar.
// Throws on a born-breached trade (entry at/past its own stop or target): simulating
// one would read as an instant entry-bar "touch" and book a phantom exit at a stale level.
export function simulateFill(
  openTrade: OpenTrade,
  bars: Candle[],
  cfg: FillConfig,
  management: ManagementModel,
): FillResult | null {
  const violation = bracketViolation(
    openTrade.direction,
    openTrade.entryPrice,
    openTrade.stopPrice,
    openTrade.targetPrice,
  );
  if (violation !== null) {
    throw new Error(
      `born-breached trade: ${openTrade.direction} entry ${openTrade.entryPrice} is at/past its ` +
        `${violation === "past-stop" ? "stop" : "target"} ` +
        `(stop ${openTrade.stopPrice}, target ${openTrade.targetPrice})`,
    );
  }
  if (bars.length === 0) return null;
  const dir = openTrade.direction;
  const target = openTrade.targetPrice;
  const risk = Math.abs(openTrade.entryPrice - openTrade.stopPrice);
  const ctx: ManageCtx = {
    bars,
    direction: dir,
    entryPrice: openTrade.entryPrice,
    entryStop: openTrade.stopPrice,
    targetPrice: target,
  };

  let stop = openTrade.stopPrice;
  let mfe = 0;
  let ambiguousBars = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // 1. Move the stop (favorable-only ratchet), from info confirmed ≤ i−1.
    const desired = management.stopForBar(i, stop, ctx);
    stop = dir === "long" ? Math.max(stop, desired) : Math.min(stop, desired);

    // 2. MFE (best excursion so far, in R).
    if (risk > 0) {
      const fav =
        dir === "long"
          ? (bar.high - openTrade.entryPrice) / risk
          : (openTrade.entryPrice - bar.low) / risk;
      if (fav > mfe) mfe = fav;
    }

    // 3. Gap-through on the open — skipped on the entry bar (we transacted at its open).
    if (i > 0 && cfg.gapFillsAtBarOpen) {
      if (dir === "long") {
        if (bar.open <= stop)
          return done(bar.timestamp, bar.open, "gap-stop", i + 1, mfe, ambiguousBars);
        if (bar.open >= target)
          return done(bar.timestamp, bar.open, "gap-target", i + 1, mfe, ambiguousBars);
      } else {
        if (bar.open >= stop)
          return done(bar.timestamp, bar.open, "gap-stop", i + 1, mfe, ambiguousBars);
        if (bar.open <= target)
          return done(bar.timestamp, bar.open, "gap-target", i + 1, mfe, ambiguousBars);
      }
    }

    // 4. Intrabar touch.
    const stopHit = dir === "long" ? bar.low <= stop : bar.high >= stop;
    const targetHit = dir === "long" ? bar.high >= target : bar.low <= target;
    if (stopHit && targetHit) {
      ambiguousBars++;
      return cfg.bothTouchedRule === "stop-first"
        ? done(bar.timestamp, stop, "stop", i + 1, mfe, ambiguousBars)
        : done(bar.timestamp, target, "target", i + 1, mfe, ambiguousBars);
    }
    if (stopHit) return done(bar.timestamp, stop, "stop", i + 1, mfe, ambiguousBars);
    if (targetHit) return done(bar.timestamp, target, "target", i + 1, mfe, ambiguousBars);

    // 5. Timeout (force-exit after maxBarsInTrade bars).
    if (cfg.maxBarsInTrade !== null && i + 1 >= cfg.maxBarsInTrade) {
      return done(bar.timestamp, bar.close, "timeout", i + 1, mfe, ambiguousBars);
    }
  }
  return null; // unresolved within the supplied window
}

function done(
  exitTs: number,
  exitPrice: number,
  exitReason: ExitReason,
  barsInTrade: number,
  mfe: number,
  ambiguousBars: number,
): FillResult {
  return { exitTs, exitPrice, exitReason, barsInTrade, mfe, ambiguousBars };
}

// Wilder ATR over the supplied bars; null if fewer than period+1 bars (the first true range needs a previous close). 
// Self-contained so the public simulator carries no dependency on the private SMA/ATR engine.
function wilderAtr(bars: Candle[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}
