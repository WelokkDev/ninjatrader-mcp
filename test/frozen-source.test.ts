import { describe, it, expect } from "vitest";
import { buildFrozenView } from "../src/core/mtf/frozen-view.js";
import { buildFrozenSource } from "../src/core/mtf/frozen-source.js";
import { getInstrumentConfig } from "../src/core/sessions/registry.js";
import type { Candle, Timeframe } from "../src/core/types.js";

// The build-once-slice optimization MUST be a pure perf refactor: for the same
// primary series, source.viewAt(asOf) has to be byte-identical to
// buildFrozenView({ primaryBars, asOf, … }). This sweeps asOf across a ~1-day
// series (which spans a CME ETH session-day boundary AND a maintenance break) at
// bar closes, non-bar instants (boundary ±1, mid-period), and the range ends,
// deep-equalling primary + completed + asOfView per TF. The equivalence is
// algorithmic (shared bucket math), so a diverse sweep catches any drift; we
// keep the sample count modest because the reference buildFrozenView is rebuilt
// in full on every call.

const STEP = 300;
const BASE = 1_700_000_000;
const TFS: Timeframe[] = ["15m", "30m", "1h", "2h", "4h"];

function series(n: number): Candle[] {
  const out: Candle[] = [];
  let prev = 18000;
  for (let i = 0; i < n; i++) {
    const ts = BASE + i * STEP;
    const close = 18000 + i * 0.1 + 8 * Math.sin(i / 15);
    const open = prev;
    out.push({
      timestamp: ts,
      open,
      high: Math.max(open, close) + 2,
      low: Math.min(open, close) - 2,
      close,
      volume: 1000 + (i % 10) * 50,
    });
    prev = close;
  }
  return out;
}

describe("buildFrozenSource ≡ buildFrozenView", () => {
  const session = getInstrumentConfig("NQ").session;
  const full = series(300); // ~25h: crosses a session boundary + maintenance break
  const source = buildFrozenSource({ primaryBars: full, timeframes: TFS, session });

  function check(asOf: number): void {
    const a = source.viewAt(asOf);
    const b = buildFrozenView({ primaryBars: full, asOf, timeframes: TFS, session });
    expect(a.primary).toEqual(b.primary);
    for (const tf of TFS) {
      expect(a.completed.get(tf)).toEqual(b.completed.get(tf));
      expect(a.asOfView.get(tf)).toEqual(b.asOfView.get(tf));
    }
  }

  it("matches across bar closes, non-bar instants, and the range ends", () => {
    check(BASE - 100); // before the first bar
    for (let i = 0; i < full.length; i += 11) check(full[i].timestamp); // bar closes
    for (let i = 7; i < full.length; i += 31) {
      const ts = full[i].timestamp;
      check(ts - 1); // just before a close
      check(ts + 1); // just after a close
      check(ts + 150); // mid-period
    }
    check(full[full.length - 1].timestamp + 100_000); // after the last bar
  }, 30000);
});
