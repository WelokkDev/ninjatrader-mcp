// Per-instrument contract numbers. Same symbol set and same throw-on-unknown
// contract as the session registry in ../sessions/registry.ts.
//
// A wrong tickSize refuses on the first bar (prices land off the grid); a wrong
// pointValue silently scales every dollar figure a run reports. That asymmetry
// is why these live in one registry rather than per-spec literals.
export interface InstrumentSpec {
  /** Minimum price increment, in the instrument's quote units. */
  tickSize: number;
  /** Dollars per one full point of price, per contract. */
  pointValue: number;
}

export const INSTRUMENTS: Record<string, Readonly<InstrumentSpec>> = {
  // CME index futures — quoted in index points.
  ES:  { tickSize: 0.25, pointValue: 50 },   // $12.50/tick
  NQ:  { tickSize: 0.25, pointValue: 20 },   // $5.00/tick
  YM:  { tickSize: 1.0,  pointValue: 5 },    // $5.00/tick
  RTY: { tickSize: 0.1,  pointValue: 50 },   // $5.00/tick
  // CME micro index futures — 1/10 of the full-size parent on the same tick
  // grid, so only pointValue carries the divisor.
  MES: { tickSize: 0.25, pointValue: 5 },    // $1.25/tick
  MNQ: { tickSize: 0.25, pointValue: 2 },    // $0.50/tick
  MYM: { tickSize: 1.0,  pointValue: 0.5 },  // $0.50/tick
  M2K: { tickSize: 0.1,  pointValue: 5 },    // $0.50/tick
  // NYMEX energy — quoted in $/barrel over a 1,000 bbl contract.
  CL:  { tickSize: 0.01, pointValue: 1000 }, // $10.00/tick
  // COMEX metals — quoted in $/troy oz over a 100 oz contract.
  GC:  { tickSize: 0.1,  pointValue: 100 },  // $10.00/tick
};

export function getInstrument(symbol: string): Readonly<InstrumentSpec> {
  const spec = INSTRUMENTS[symbol];
  if (spec === undefined) {
    throw new Error(
      `No contract spec for symbol "${symbol}". Add it to src/core/instruments/tick-size.ts.`,
    );
  }
  return spec;
}

export function getTickSize(symbol: string): number {
  return getInstrument(symbol).tickSize;
}

export function getPointValue(symbol: string): number {
  return getInstrument(symbol).pointValue;
}
