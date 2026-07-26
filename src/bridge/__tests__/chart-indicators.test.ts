import { describe, it, expect } from "vitest";
import { parseMessage } from "../protocol.js";

const sma = {
  id: 3,
  name: "NinjaTrader.NinjaScript.Indicators.SMA",
  displayName: "SMA(20)",
  panel: -1,
  isOverlay: true,
  displacement: 0,
  readableDepth: "TwoHundredFiftySix",
  params: [{ name: "Period", label: "Period", value: 20 }],
  plots: [{ name: "SMA", color: "#FFFFA500", style: "Line" }],
};

// The other two param value types, plus a null plot color and an omitted style.
const priorDayOhlc = {
  id: 7,
  name: "NinjaTrader.NinjaScript.Indicators.PriorDayOHLC",
  displayName: "PriorDayOHLC",
  panel: -1,
  isOverlay: true,
  displacement: -2,
  readableDepth: "Infinite",
  params: [
    { name: "ShowClose", label: "Show close", value: true },
    { name: "PriceMode", label: "Price mode", value: "Last" },
  ],
  plots: [{ name: "PriorClose", color: null }],
};

function chartsMsg(indicators: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    id: "r1",
    type: "chart_indicators_response",
    charts: [
      {
        window: "MNQ 09-26  15 Second",
        symbol: "MNQ",
        instrument: "MNQ SEP26",
        timeframe: "15s",
        isActive: true,
        indicators,
      },
    ],
    ...extra,
  });
}

describe("parseMessage: chart_indicators_response", () => {
  it("accepts a full response with both param and plot shapes", () => {
    const res = parseMessage(chartsMsg([sma, priorDayOhlc], { skippedWindows: 0 }));
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "chart_indicators_response") {
      expect(res.message.charts[0].indicators).toHaveLength(2);
      expect(res.message.charts[0].indicators[0].params[0].value).toBe(20);
      expect(res.message.charts[0].indicators[1].plots[0].color).toBeNull();
      expect(res.message.charts[0].indicators[1].plots[0].style).toBeUndefined();
      expect(res.message.charts[0].indicators[1].displacement).toBe(-2);
    }
  });

  it("accepts a chart with no indicators, and no charts at all", () => {
    expect(parseMessage(chartsMsg([])).ok).toBe(true);
    expect(
      parseMessage(
        JSON.stringify({ v: 1, id: "r1", type: "chart_indicators_response", charts: [] }),
      ).ok,
    ).toBe(true);
  });

  it("defaults a missing skippedWindows to 0", () => {
    const res = parseMessage(chartsMsg([sma]));
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "chart_indicators_response") {
      expect(res.message.skippedWindows).toBe(0);
    }
  });

  it("rejects a missing envelope id", () => {
    const res = parseMessage(
      JSON.stringify({ v: 1, type: "chart_indicators_response", charts: [] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("chart_indicators_response: id");
  });

  it("rejects an indicator with no id handle", () => {
    const { id: _dropped, ...noId } = sma;
    const res = parseMessage(chartsMsg([noId]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("charts");
  });

  it("rejects a non-scalar param value", () => {
    const bad = { ...sma, params: [{ name: "Period", label: "Period", value: { n: 20 } }] };
    expect(parseMessage(chartsMsg([bad])).ok).toBe(false);
  });

  it("rejects a wrong-typed skippedWindows instead of coercing it", () => {
    expect(parseMessage(chartsMsg([sma], { skippedWindows: "3" })).ok).toBe(false);
  });
});

function valuesMsg(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    id: "r1",
    type: "indicator_values_response",
    found: true,
    symbol: "MNQ",
    timeframe: "15s",
    window: "MNQ 09-26  15 Second",
    indicatorId: 3,
    displayName: "SMA(20)",
    matchCount: 1,
    displacement: 0,
    barCount: 2,
    barsFrom: 1_753_465_000,
    barsTo: 1_753_468_815,
    plots: [
      {
        name: "SMA",
        values: [
          { t: 1_753_468_800, v: 21050.25 },
          { t: 1_753_468_815, v: 21050.4 },
        ],
        availableFrom: 1_753_468_800,
        availableTo: 1_753_468_815,
        truncated: false,
      },
    ],
    ...extra,
  });
}

describe("parseMessage: indicator_values_response", () => {
  it("accepts a full response", () => {
    const res = parseMessage(valuesMsg());
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "indicator_values_response") {
      expect(res.message.plots[0].values).toHaveLength(2);
      expect(res.message.plots[0].values[1].v).toBe(21050.4);
      // The handle is `indicatorId`; `id` stays the correlation uuid.
      expect(res.message.indicatorId).toBe(3);
      expect(res.message.id).toBe("r1");
    }
  });

  it("accepts found:false with no plots and defaults them to an empty array", () => {
    const res = parseMessage(
      JSON.stringify({
        v: 1,
        id: "r1",
        type: "indicator_values_response",
        found: false,
        reason: "no open chart matches symbol=MNQ",
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "indicator_values_response") {
      expect(res.message.plots).toEqual([]);
      expect(res.message.reason).toContain("no open chart");
    }
  });

  it("accepts a plot that served nothing (null availability)", () => {
    const res = parseMessage(
      valuesMsg({
        plots: [
          { name: "SMA", values: [], availableFrom: null, availableTo: null, truncated: false },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "indicator_values_response") {
      expect(res.message.plots[0].availableFrom).toBeNull();
    }
  });

  it("rejects a non-numeric value point", () => {
    const res = parseMessage(
      valuesMsg({
        plots: [
          {
            name: "SMA",
            values: [{ t: 1_753_468_800, v: "21050.25" }],
            availableFrom: 1_753_468_800,
            availableTo: 1_753_468_800,
            truncated: false,
          },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("plots");
  });

  it("rejects a plot missing its truncated flag", () => {
    expect(
      parseMessage(
        valuesMsg({
          plots: [{ name: "SMA", values: [], availableFrom: null, availableTo: null }],
        }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a missing found flag", () => {
    const res = parseMessage(
      JSON.stringify({ v: 1, id: "r1", type: "indicator_values_response", plots: [] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("found");
  });
});
