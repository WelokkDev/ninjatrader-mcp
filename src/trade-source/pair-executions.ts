import type { RawExecution, RawTrade } from "./types.js";

/**
 * Folds a flat list of broker fills (RawExecution[]) into round-trip trades
 * (RawTrade[]) using per-symbol FIFO position-segment tracking.
 *
 * Algorithm
 * ---------
 * - Fills are grouped by symbol; each symbol runs an independent state machine.
 * - Within a symbol, fills are stable-sorted by time ascending; same-second
 *   ties retain their original input order (Array.prototype.sort is stable).
 * - Running signed position: buy = +quantity, sell = −quantity.
 *
 * State transitions per fill:
 *   flat → non-flat            opens a new trade (direction from sign)
 *   same-sign extend            adds fill to weighted ENTRY average; updates peak
 *   opposite-sign, stays side   adds fill to weighted EXIT average
 *   opposite-sign, hits zero    adds to exit avg, CLOSES the trade
 *   opposite-sign, crosses zero FLIP — split the fill at the zero crossing:
 *     closing portion  → contributes to exit avg, closes current trade
 *     remainder        → opens a new trade at this fill's price/time/externalId
 *
 * Commission for a flip fill is split proportionally by quantity so that
 *   closingComm + remainderComm = fillComm (total is conserved, no double-count).
 *
 * Open position at series end → emitted with exitTime: null, exitPrice: null.
 * realizedPnl is left null here (set by the adapter if the broker provides it).
 * source is left "" here (the adapter stamps the real source after pairing).
 *
 * Output order
 * ------------
 * Trades are returned sorted by entryTime ascending.  Same-entryTime ties are
 * broken by the original input-array index of the trade's opening fill (stable
 * tiebreak across all symbols).  Tests may rely on this ordering.
 *
 * Pure: no I/O, no Date, no mutation of the input array.
 *
 * Integer-contract assumption
 * ---------------------------
 * This pairing algorithm assumes integer-contract quantities (NinjaTrader
 * futures — NQ, ES, etc.).  POSITION_EPSILON absorbs any float accumulation
 * error.  Instruments with fractional quantities (e.g. shares/crypto via a
 * future IBKR adapter) should scale to integer minimal units before pairing.
 */

// ── Floating-point zero guard ─────────────────────────────────────────────────
// For integer fills |position| is exactly 0 or ≥ 1, so isFlat(x) is equivalent
// to x === 0.  The epsilon matters if fractional instruments are ever added.
const POSITION_EPSILON = 1e-9;
const isFlat = (p: number): boolean => Math.abs(p) < POSITION_EPSILON;

// ── Internal accumulator for one in-flight position segment ───────────────────

interface OpenSegment {
  externalId: string;
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  /** Σ(price × qty) for all fills that extended the position (denominator = entryQty). */
  entryPriceSum: number;
  /** Σqty for all fills that extended the position. */
  entryQty: number;
  /** Σ(price × qty) for all fills that reduced the position (denominator = exitQty). */
  exitPriceSum: number;
  /** Σqty for all fills that reduced the position. */
  exitQty: number;
  /** Maximum |position| reached during this segment. Stored as the trade's quantity. */
  peakAbs: number;
  /** Σcommission across all fills belonging to this segment (null treated as 0). */
  commissionSum: number;
  /** Opening fill's raw field — carried forward for audit. */
  raw: unknown;
  /**
   * Original input-array index of the opening fill.
   * Used as a stable tiebreak when two trades share the same entryTime.
   */
  openOrdinal: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function createSegment(
  fill: RawExecution,
  qty: number,
  commission: number,
  ordinal: number,
): OpenSegment {
  return {
    externalId: fill.externalId,
    symbol: fill.symbol,
    direction: fill.side === "buy" ? "long" : "short",
    entryTime: fill.time,
    entryPriceSum: fill.price * qty,
    entryQty: qty,
    exitPriceSum: 0,
    exitQty: 0,
    peakAbs: qty,
    commissionSum: commission,
    raw: fill.raw,
    openOrdinal: ordinal,
  };
}

function closeSegment(seg: OpenSegment, exitTime: number | null): RawTrade {
  const closed = exitTime !== null;
  return {
    externalId: seg.externalId,
    source: "",   // adapter stamps the real source after pairing
    symbol: seg.symbol,
    direction: seg.direction,
    entryTime: seg.entryTime,
    entryPrice: seg.entryPriceSum / seg.entryQty,
    exitTime,
    // seg.exitQty > 0 is a deliberate div-by-zero guard (defensive; keep it).
    exitPrice: closed && seg.exitQty > 0 ? seg.exitPriceSum / seg.exitQty : null,
    quantity: seg.peakAbs,
    commission: seg.commissionSum,
    realizedPnl: null,
    raw: seg.raw,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function pairExecutions(execs: RawExecution[]): RawTrade[] {
  // Group fills by symbol, tagging each with its original input index.
  const bySymbol = new Map<string, Array<{ fill: RawExecution; origIdx: number }>>();
  for (let i = 0; i < execs.length; i++) {
    const fill = execs[i];
    let bucket = bySymbol.get(fill.symbol);
    if (bucket === undefined) {
      bucket = [];
      bySymbol.set(fill.symbol, bucket);
    }
    bucket.push({ fill, origIdx: i });
  }

  // Stable-sort each symbol's bucket by fill time.
  // Array.prototype.sort is stable per the ECMAScript spec (ES2019+) and all
  // modern engines — same-second ties retain their original input order.
  for (const bucket of bySymbol.values()) {
    bucket.sort((a, b) => a.fill.time - b.fill.time);
  }

  const emitted: Array<{ trade: RawTrade; openOrdinal: number }> = [];

  for (const bucket of bySymbol.values()) {
    let position = 0;
    let seg: OpenSegment | null = null;

    for (const { fill, origIdx } of bucket) {
      // Skip fills with non-positive quantity — they carry no position change
      // and would corrupt price averages (NaN from 0-denomination arithmetic).
      if (fill.quantity <= 0) continue;

      const signedDelta = fill.side === "buy" ? fill.quantity : -fill.quantity;
      const newPosition = position + signedDelta;
      const fillComm = fill.commission ?? 0;

      if (isFlat(position)) {
        // ── Flat → open ──────────────────────────────────────────────────────
        seg = createSegment(fill, fill.quantity, fillComm, origIdx);
        position = newPosition;
        continue;
      }

      const extending = Math.sign(signedDelta) === Math.sign(position);

      if (extending) {
        // ── Scale-in: extends the current position ────────────────────────────
        seg!.entryPriceSum += fill.price * fill.quantity;
        seg!.entryQty += fill.quantity;
        seg!.commissionSum += fillComm;
        const absNew = Math.abs(newPosition);
        if (absNew > seg!.peakAbs) seg!.peakAbs = absNew;
        position = newPosition;
      } else if (isFlat(newPosition)) {
        // ── Exact close: position returns precisely to flat ───────────────────
        seg!.exitPriceSum += fill.price * fill.quantity;
        seg!.exitQty += fill.quantity;
        seg!.commissionSum += fillComm;
        emitted.push({ trade: closeSegment(seg!, fill.time), openOrdinal: seg!.openOrdinal });
        seg = null;
        position = 0; // snap to exact zero
      } else if (Math.sign(newPosition) === Math.sign(position)) {
        // ── Partial reduction: same side, doesn't cross zero ──────────────────
        seg!.exitPriceSum += fill.price * fill.quantity;
        seg!.exitQty += fill.quantity;
        seg!.commissionSum += fillComm;
        position = newPosition;
      } else {
        // ── Flip: this fill crosses through zero ──────────────────────────────
        // Split the fill at the zero crossing.
        const closingQty = Math.abs(position); // portion that brings position to 0
        const remainderQty = fill.quantity - closingQty; // always > 0 here

        // Commission split proportionally by quantity so that
        // closingComm + remainderComm = fillComm (total is conserved, no double-count).
        const closingComm = fillComm * (closingQty / fill.quantity);
        const remainderComm = fillComm * (remainderQty / fill.quantity);

        // Apply closing portion to the current segment and close it.
        seg!.exitPriceSum += fill.price * closingQty;
        seg!.exitQty += closingQty;
        seg!.commissionSum += closingComm;
        emitted.push({ trade: closeSegment(seg!, fill.time), openOrdinal: seg!.openOrdinal });

        // Open a new segment for the remainder at this fill's price and time.
        // The new trade's direction is inferred from fill.side:
        //   sell + flip from long → "short"; buy + flip from short → "long".
        seg = createSegment(fill, remainderQty, remainderComm, origIdx);
        position = newPosition;
      }
    }

    // Residual open position at end of series.
    if (seg !== null) {
      emitted.push({ trade: closeSegment(seg, null), openOrdinal: seg.openOrdinal });
    }
  }

  // Sort by entryTime ascending; ties broken by openOrdinal (original input index).
  emitted.sort((a, b) => {
    const dt = a.trade.entryTime - b.trade.entryTime;
    return dt !== 0 ? dt : a.openOrdinal - b.openOrdinal;
  });

  return emitted.map((e) => e.trade);
}
