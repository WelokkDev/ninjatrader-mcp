import { describe, it, expect } from "vitest";
import {
  bracketViolation,
  ChandelierTrail,
  ConstrainedTrail,
  fixedManagement,
  simulateFill,
} from "../src/core/decision/fill-simulator.js";
import type { FillConfig, OpenTrade } from "../src/core/decision/types.js";
import type { Candle } from "../src/core/types.js";

// Fill simulator (§4.2) unit tests. The exit math is the one genuinely new
// piece of judgment in the backtest build, so it is pinned here in isolation:
// clean stop/target, gap-through, both-touched tie-break, timeout, the
// no-resolve null, and that the management models actually move (and ratchet)
// the stop. bars[0] is the ENTRY bar (filled at openTrade.entryPrice = its
// open), so it gets no gap check, only an intrabar-hit check.

const TS = 1_700_000_000;
const STEP = 300;
function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { timestamp: TS + i * STEP, open: o, high: h, low: l, close: c, volume: 1000 };
}

const CFG: FillConfig = {
  bothTouchedRule: "stop-first",
  gapFillsAtBarOpen: true,
  maxBarsInTrade: null,
};

function longTrade(over: Partial<OpenTrade> = {}): OpenTrade {
  return {
    tradeId: "t",
    symbol: "NQ",
    direction: "long",
    entryPrice: 100,
    entryTs: TS,
    stopPrice: 98,
    targetPrice: 108,
    ...over,
  };
}

describe("simulateFill — exits", () => {
  it("clean target (long): exits at the target level", () => {
    const bars = [
      bar(0, 100, 101, 99.5, 100.5), // entry bar, benign
      bar(1, 100.5, 108, 100, 107.5), // tags target
    ];
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement)!;
    expect(r.exitReason).toBe("target");
    expect(r.exitPrice).toBe(108);
    expect(r.barsInTrade).toBe(2);
  });

  it("clean stop (long): exits at the stop level", () => {
    const bars = [
      bar(0, 100, 101, 99.5, 100),
      bar(1, 100, 100.5, 98, 98.5), // tags stop
    ];
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement)!;
    expect(r.exitReason).toBe("stop");
    expect(r.exitPrice).toBe(98);
  });

  it("same-bar exit IS allowed on the entry bar (we hold from its open)", () => {
    const bars = [bar(0, 100, 108, 100, 104)]; // entry bar reaches the target
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement)!;
    expect(r.exitReason).toBe("target");
    expect(r.barsInTrade).toBe(1);
  });

  it("gap-stop (long): a bar opening below the stop fills at the open", () => {
    const bars = [bar(0, 100, 101, 99.5, 100), bar(1, 97, 97.5, 96, 96.5)];
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement)!;
    expect(r.exitReason).toBe("gap-stop");
    expect(r.exitPrice).toBe(97);
  });

  it("gap-target (long): a bar opening above the target fills at the open", () => {
    const bars = [bar(0, 100, 101, 99.5, 100), bar(1, 109, 110, 109, 109.5)];
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement)!;
    expect(r.exitReason).toBe("gap-target");
    expect(r.exitPrice).toBe(109);
  });

  it("no gap fill on the entry bar even if it opens through a level", () => {
    // The entry bar's open IS the fill; it must not be read as a gap.
    const bars = [bar(0, 100, 101, 100, 100.5)];
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement);
    expect(r).toBeNull(); // never resolves; no spurious gap-stop/target
  });

  it("both-touched: stop-first tie-break (conservative)", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 108, 98, 101)];
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement)!;
    expect(r.exitReason).toBe("stop");
    expect(r.exitPrice).toBe(98);
    expect(r.ambiguousBars).toBe(1);
  });

  it("both-touched: target-first tie-break", () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 108, 98, 101)];
    const r = simulateFill(longTrade(), bars, { ...CFG, bothTouchedRule: "target-first" }, fixedManagement)!;
    expect(r.exitReason).toBe("target");
    expect(r.exitPrice).toBe(108);
    expect(r.ambiguousBars).toBe(1);
  });

  it("timeout: force-exit at the bar close after maxBarsInTrade bars", () => {
    const bars = [
      bar(0, 100, 101, 99.5, 100),
      bar(1, 100, 101, 99.5, 100.25), // no hit; timeout fires here
    ];
    const r = simulateFill(longTrade(), bars, { ...CFG, maxBarsInTrade: 2 }, fixedManagement)!;
    expect(r.exitReason).toBe("timeout");
    expect(r.exitPrice).toBe(100.25);
    expect(r.barsInTrade).toBe(2);
  });

  it("returns null when the trade never resolves within the window", () => {
    const bars = [bar(0, 100, 101, 99.5, 100), bar(1, 100, 101, 99.5, 100)];
    expect(simulateFill(longTrade(), bars, CFG, fixedManagement)).toBeNull();
  });

  it("short trade: clean target is sign-correct", () => {
    const short = longTrade({ direction: "short", stopPrice: 102, targetPrice: 92 });
    const bars = [bar(0, 100, 100.5, 99, 99.5), bar(1, 99.5, 100, 92, 92.5)];
    const r = simulateFill(short, bars, CFG, fixedManagement)!;
    expect(r.exitReason).toBe("target");
    expect(r.exitPrice).toBe(92);
  });

  it("tracks MFE in R", () => {
    // risk = 2; best high 104 → (104-100)/2 = 2R before exiting at the stop.
    const bars = [bar(0, 100, 104, 100, 101), bar(1, 101, 101, 98, 98.5)];
    const r = simulateFill(longTrade(), bars, CFG, fixedManagement)!;
    expect(r.mfe).toBeCloseTo(2, 6);
    expect(r.exitReason).toBe("stop");
  });
});

describe("simulateFill — bracket contract (born-breached trades are refused)", () => {
  // A long whose entry is at/below its stop would read as an entry-bar stop
  // "touch" and book a phantom +1.0R win at the stale level (the 2026-07-07
  // audit found 4 such trades, all recorded exactly +1R / "stop" / 1 bar).
  // simulateFill must throw, not simulate.
  it("throws on a long entered at/below its stop", () => {
    const t = longTrade({ entryPrice: 97.5, stopPrice: 98 }); // entry below stop
    const bars = [bar(0, 97.5, 99, 97, 98.5)];
    expect(() => simulateFill(t, bars, CFG, fixedManagement)).toThrow(/past its stop/);
  });

  it("throws on a short entered at/above its stop", () => {
    // Real 4/20 geometry, scaled: short filled above the wick-anchored stop.
    const t = longTrade({ direction: "short", entryPrice: 102.5, stopPrice: 102, targetPrice: 92 });
    const bars = [bar(0, 102.5, 103, 101, 102)];
    expect(() => simulateFill(t, bars, CFG, fixedManagement)).toThrow(/past its stop/);
  });

  it("throws on entry exactly AT the stop (zero-risk degenerate)", () => {
    const t = longTrade({ entryPrice: 98, stopPrice: 98 });
    expect(() => simulateFill(t, [bar(0, 98, 99, 97, 98.5)], CFG, fixedManagement)).toThrow(
      /past its stop/,
    );
  });

  it("throws on a long entered at/past its target (phantom-loss mirror)", () => {
    const t = longTrade({ entryPrice: 108.5, targetPrice: 108 });
    expect(() => simulateFill(t, [bar(0, 108.5, 109, 108, 108.5)], CFG, fixedManagement)).toThrow(
      /past its target/,
    );
  });

  it("bracketViolation: names the violated side; null strictly inside", () => {
    expect(bracketViolation("long", 100, 98, 108)).toBeNull();
    expect(bracketViolation("short", 100, 102, 92)).toBeNull();
    expect(bracketViolation("long", 98, 98, 108)).toBe("past-stop");
    expect(bracketViolation("long", 97, 98, 108)).toBe("past-stop");
    expect(bracketViolation("long", 108, 98, 108)).toBe("past-target");
    expect(bracketViolation("short", 102.5, 102, 92)).toBe("past-stop");
    expect(bracketViolation("short", 91, 102, 92)).toBe("past-target");
  });
});

describe("simulateFill — management models move the stop", () => {
  it("ChandelierTrail ratchets the stop up and exits a long ABOVE entry", () => {
    const trade = longTrade({ stopPrice: 95, targetPrice: 130 });
    const bars = [
      bar(0, 100, 101, 99, 101),
      bar(1, 101, 103, 100, 103),
      bar(2, 103, 105, 102, 105),
      bar(3, 105, 107, 104, 107),
      bar(4, 107, 108, 101, 102), // pulls back into the trailed stop (≈104)
    ];
    const r = simulateFill(trade, bars, CFG, new ChandelierTrail(1, 2))!;
    expect(r.exitReason).toBe("stop");
    expect(r.exitPrice).toBeGreaterThan(100); // exited at a trailed stop above entry
    expect(r.exitPrice).toBeLessThan(107);
  });

  it("ConstrainedTrail applies the precomputed candidate (favorable ratchet)", () => {
    const trade = longTrade({ stopPrice: 95, targetPrice: 130 });
    const bars = [
      bar(0, 100, 101, 99, 100.5),
      bar(1, 100.5, 102, 100, 101),
      bar(2, 102, 103, 100, 101.5), // candidate raises stop to 101; opens above it, low 100 stops out intrabar
    ];
    const candidates = [NaN, NaN, 101];
    const r = simulateFill(trade, bars, CFG, new ConstrainedTrail(candidates))!;
    expect(r.exitReason).toBe("stop");
    expect(r.exitPrice).toBe(101);
    expect(r.barsInTrade).toBe(3);
  });

  it("fixedManagement never moves the stop", () => {
    const trade = longTrade({ stopPrice: 95, targetPrice: 130 });
    const bars = [
      bar(0, 100, 101, 99, 101),
      bar(1, 101, 103, 100, 103),
      bar(2, 103, 105, 96, 104), // dips to 96 — above the fixed 95, so no exit
    ];
    expect(simulateFill(trade, bars, CFG, fixedManagement)).toBeNull();
  });
});
