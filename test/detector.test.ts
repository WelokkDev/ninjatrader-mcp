import { describe, it, expect } from "vitest";
import { detectWaws } from "../src/private/waw/detector.js";
import { loadStrategy } from "../src/private/waw/strategy-loader.js";
import type { Candle, MarketContext } from "../src/private/waw/types.js";

function bar(
  ts: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 0 };
}

describe("detectWaws — integration", () => {
  it("emits exactly the demand and supply zones in a 7-candle synthetic series", () => {
    const t = 1700000000;
    // Doji candles at indices 0, 3, 6 act as separators that disqualify
    // the surrounding pairs (either by c1-doji or c2-doji rule).
    const candles: Candle[] = [
      bar(t,         100, 100, 100, 100),
      bar(t + 60,    101, 101,  99,   99),
      bar(t + 120,    99.5, 100.5,  99.2, 100.5),
      bar(t + 180,   100, 100, 100, 100),
      bar(t + 240,    99, 101,  99,  101),
      bar(t + 300,   100.5, 100.8,  99.5,  99.5),
      bar(t + 360,   100, 100, 100, 100),
    ];

    const strategy = loadStrategy({
      name: "test",
      detection: { allowDojiAsCandle2: false, minWickCoverageOfPriorBody: 0 },
      quantifiers: [{ name: "autoAccept", enabled: true, config: {} }],
    });

    const ctx: MarketContext = {
      candles,
      symbol: "NQ",
      timeframe: "240m",
    };

    const zones = detectWaws(candles, ctx, strategy);

    expect(zones).toHaveLength(2);

    expect(zones[0]).toMatchObject({
      type: "demand",
      proximal: 99.5,
      distal: 99.2,
      c1Index: 1,
      c2Index: 2,
      qualified: true,
    });
    expect(zones[0].c1Timestamp).toBe(new Date((t + 60) * 1000).toISOString());
    expect(zones[0].c2Timestamp).toBe(new Date((t + 120) * 1000).toISOString());
    expect(zones[0].quantifierResults).toEqual([
      {
        quantifierName: "autoAccept",
        passed: true,
        reason: "auto-accept stub",
      },
    ]);

    expect(zones[1]).toMatchObject({
      type: "supply",
      proximal: 100.5,
      distal: 100.8,
      c1Index: 4,
      c2Index: 5,
      qualified: true,
    });
  });

  it("does not mutate the input candles array", () => {
    const t = 1700000000;
    const candles: Candle[] = [
      bar(t,         101, 101,  99,   99),
      bar(t + 60,     99.5, 100.5,  99.2, 100.5),
    ];
    const snapshot = JSON.parse(JSON.stringify(candles));
    const strategy = loadStrategy({
      name: "test",
      detection: { allowDojiAsCandle2: false, minWickCoverageOfPriorBody: 0 },
      quantifiers: [],
    });

    detectWaws(candles, { candles, symbol: "NQ", timeframe: "15m" }, strategy);

    expect(candles).toEqual(snapshot);
  });

  it("zone is qualified=true when all quantifiers are disabled", () => {
    const t = 1700000000;
    const candles: Candle[] = [
      bar(t,         101, 101,  99,   99),
      bar(t + 60,     99.5, 100.5,  99.2, 100.5),
    ];
    const strategy = loadStrategy({
      name: "test",
      detection: { allowDojiAsCandle2: false, minWickCoverageOfPriorBody: 0 },
      quantifiers: [
        { name: "autoAccept", enabled: false, config: {} },
        { name: "timeOfDay", enabled: false, config: {} },
      ],
    });

    const zones = detectWaws(
      candles,
      { candles, symbol: "NQ", timeframe: "15m" },
      strategy,
    );

    expect(zones).toHaveLength(1);
    expect(zones[0].qualified).toBe(true);
    expect(zones[0].quantifierResults).toEqual([]);
  });
});
