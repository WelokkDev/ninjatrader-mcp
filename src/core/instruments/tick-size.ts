// Per-instrument minimum price increment (tick size).
//
// Lifted out of a private engine config — where it lived as a hardcoded
// 0.25 default — so that every consumer reads one source of truth.
// Parallels the session registry in ../sessions/registry.ts:
// same symbol set, same "throw on unknown symbol" contract.
//
// Values are the exchange-listed minimum ticks for the front-month
// outright (not spreads):
//   ES/NQ/MES/MNQ  0.25 index pts
//   YM/MYM         1.0  index pts
//   RTY/M2K        0.10 index pts
//   CL             0.01 $/bbl
//   GC             0.10 $/oz
const TICK_SIZE: Record<string, number> = {
  // CME index futures
  ES: 0.25,
  NQ: 0.25,
  YM: 1.0,
  RTY: 0.1,
  // CME micro index futures
  MES: 0.25,
  MNQ: 0.25,
  MYM: 1.0,
  M2K: 0.1,
  // NYMEX energy
  CL: 0.01,
  // COMEX metals
  GC: 0.1,
};

export function getTickSize(symbol: string): number {
  const t = TICK_SIZE[symbol];
  if (t === undefined) {
    throw new Error(
      `No tick size for symbol "${symbol}". Add it to src/core/instruments/tick-size.ts.`,
    );
  }
  return t;
}
