import type { Database } from "better-sqlite3";
import type { SessionDay } from "../sessions/types.js";
import type { Candle, Timeframe } from "../types.js";
import type { SessionDayResolver } from "../sessions/session-day.js";
import { validateSessionDay } from "./validator.js";

// Daily ("1d") is a RAW stream: NT8 builds one bar per session-day off the
// same trading-hours template we resolve session-days with. Two things about
// it need care, and both live here.
//
// 1. STAMP. NT8's daily bar time is not guaranteed to be the session close —
//    depending on the provider it can be the trading date at midnight, or the
//    session close. Rather than encode a guess, ingest RE-STAMPS every daily
//    bar onto the `endUnix` of the session-day that contains its stamp. The
//    cache then holds pure session geometry (validator, purge, and every
//    query speak one convention) no matter what NT8 hands over.
//
// 2. TRUST. Re-stamping is only safe if the bar lands on the RIGHT day. A
//    convention we didn't anticipate (e.g. a stamp rolled to the following
//    midnight) would shift every bar by one session, silently. So each
//    ingested daily bar is reconciled against the intraday bars already
//    cached for the day it was assigned to: same session, same OHLC. A
//    mismatch is reported loudly instead of being quietly written.

/** How the incoming stamp related to its session-day — the observed NT8
 *  convention, reported once per ingest so the first real fetch settles it. */
export type DailyStampConvention =
  | "session_close" // stamp === endUnix; already canonical
  | "session_open" // stamp === startUnix (resolved via the +1s probe)
  | "in_session"; // somewhere inside the session, e.g. trading date midnight

export interface NormalizedDailyBar {
  /** The bar re-stamped onto its session-day's close. */
  candle: Candle;
  day: SessionDay;
  /** The stamp NT8 sent, before re-stamping. */
  sourceTimestamp: number;
  convention: DailyStampConvention;
}

export interface DailyNormalizeResult {
  bars: NormalizedDailyBar[];
  /** Bars whose stamp fell in no session-day at all — caller drops these. */
  unresolved: Candle[];
}

/**
 * Re-stamp daily bars onto their session-day close.
 *
 * The half-open (startUnix, endUnix] convention excludes a stamp landing
 * exactly on the session open, so an unresolved stamp gets one +1s probe
 * before being given up on. Anything still unresolved is a stamp outside every
 * session (a weekend/holiday midnight, say) and is the caller's to drop.
 */
export function normalizeDailyStamps(
  candles: readonly Candle[],
  resolveDay: SessionDayResolver,
): DailyNormalizeResult {
  const bars: NormalizedDailyBar[] = [];
  const unresolved: Candle[] = [];

  for (const c of candles) {
    let day = resolveDay(c.timestamp);
    let convention: DailyStampConvention = "in_session";
    if (day === null) {
      // Exactly on the open boundary: belongs to the session it opens.
      day = resolveDay(c.timestamp + 1);
      if (day === null) {
        unresolved.push(c);
        continue;
      }
      convention = "session_open";
    } else if (c.timestamp === day.endUnix) {
      convention = "session_close";
    }
    bars.push({
      candle: { ...c, timestamp: day.endUnix },
      day,
      sourceTimestamp: c.timestamp,
      convention,
    });
  }

  return { bars, unresolved };
}

/** Distinct conventions observed in one batch, for a single summary log. */
export function summarizeConventions(bars: readonly NormalizedDailyBar[]): string {
  const counts = new Map<DailyStampConvention, number>();
  for (const b of bars) counts.set(b.convention, (counts.get(b.convention) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(" ");
}

// ── reconciliation ───────────────────────────────────────────────────────────

// Intraday TFs to reconcile a daily bar against, coarsest first (fewest rows).
const RECONCILE_TIMEFRAMES: readonly Timeframe[] = ["15m", "5m", "15s"];

export interface DailyFieldMismatch {
  field: "open" | "high" | "low" | "close";
  daily: number;
  intraday: number;
}

export interface DailyReconcileResult {
  day: string;
  /** The intraday TF the check ran against; null = no complete TF cached. */
  against: Timeframe | null;
  mismatches: DailyFieldMismatch[];
}

/**
 * Check one ingested daily bar against the intraday bars already cached for
 * the session-day it was assigned to: the daily open must equal the session's
 * first intraday open, the close its last close, and the extremes must agree.
 *
 * Only runs against a CLOSED session-day that is structurally complete at some
 * intraday TF — a holed intraday day would report false extremes. Returns
 * `against: null` when no such TF is cached (nothing to say, not a pass).
 *
 * This is the guard that makes re-stamping trustworthy: a daily bar filed
 * under the wrong session cannot match that session's own intraday bars.
 */
export function reconcileDailyAgainstIntraday(
  db: Database,
  symbol: string,
  day: SessionDay,
  daily: Candle,
  nowUnix: number,
): DailyReconcileResult {
  if (day.endUnix > nowUnix) return { day: day.label, against: null, mismatches: [] };

  for (const tf of RECONCILE_TIMEFRAMES) {
    if (validateSessionDay(db, symbol, day, tf, nowUnix).status !== "ok") continue;

    const agg = db
      .prepare(
        `SELECT MAX(high) AS hi, MIN(low) AS lo,
                (SELECT open  FROM candles
                  WHERE symbol = ? AND timeframe = ?
                    AND timestamp > ? AND timestamp <= ?
                  ORDER BY timestamp ASC  LIMIT 1) AS first_open,
                (SELECT close FROM candles
                  WHERE symbol = ? AND timeframe = ?
                    AND timestamp > ? AND timestamp <= ?
                  ORDER BY timestamp DESC LIMIT 1) AS last_close
           FROM candles
          WHERE symbol = ? AND timeframe = ?
            AND timestamp > ? AND timestamp <= ?`,
      )
      .get(
        symbol, tf, day.startUnix, day.endUnix,
        symbol, tf, day.startUnix, day.endUnix,
        symbol, tf, day.startUnix, day.endUnix,
      ) as {
      hi: number | null;
      lo: number | null;
      first_open: number | null;
      last_close: number | null;
    };

    if (agg.first_open === null || agg.last_close === null || agg.hi === null || agg.lo === null) {
      continue;
    }

    const mismatches: DailyFieldMismatch[] = [];
    const check = (field: DailyFieldMismatch["field"], a: number, b: number): void => {
      // Exact equality on purpose: both sides are the same exchange prints, so
      // any real difference is a signal (wrong day, wrong contract, wrong
      // session template) rather than float noise. Tolerate only ULP-scale
      // drift from SQLite's REAL round-trip.
      if (Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * 1e-9) {
        mismatches.push({ field, daily: a, intraday: b });
      }
    };
    check("open", daily.open, agg.first_open);
    check("high", daily.high, agg.hi);
    check("low", daily.low, agg.lo);
    check("close", daily.close, agg.last_close);

    return { day: day.label, against: tf, mismatches };
  }

  return { day: day.label, against: null, mismatches: [] };
}

/** One-line report for a reconciliation that found something. */
export function describeReconcileMismatch(r: DailyReconcileResult): string {
  const fields = r.mismatches
    .map((m) => `${m.field} daily=${m.daily} vs ${r.against}=${m.intraday}`)
    .join(", ");
  return `${r.day}: ${fields}`;
}
