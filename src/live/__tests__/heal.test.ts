import { describe, it, expect, vi } from "vitest";
import { GapHealer, HEAL_MAX_WINDOW_SECS, type HealDeps } from "../heal.js";
import type { DetectedGap } from "../recorder.js";

const NOW = 1_789_000_000;

function gap(over: Partial<DetectedGap> = {}): DetectedGap {
  return {
    symbol: "NQ",
    timeframe: "5m",
    fromTs: NOW - 3_600,
    toTs: NOW - 3_000,
    ...over,
  };
}

function makeDeps(over: Partial<HealDeps> = {}): HealDeps {
  return {
    request: vi.fn(async () => ({})),
    isConnected: () => true,
    nowUnix: () => NOW,
    ...over,
  };
}

describe("GapHealer", () => {
  it("declines while disconnected", async () => {
    const deps = makeDeps({ isConnected: () => false });
    const healer = new GapHealer(deps);
    const res = await healer.heal(gap());
    expect(res.requested).toBe(false);
    expect(res.reason).toMatch(/not connected/i);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("requests the gap window with one-bar overlap margins and the session template", async () => {
    const deps = makeDeps();
    const healer = new GapHealer(deps);
    const res = await healer.heal(gap());
    expect(res.requested).toBe(true);
    expect(deps.request).toHaveBeenCalledWith(
      "request_candles",
      {
        symbol: "NQ",
        timeframe: "5m",
        from: NOW - 3_600 - 300,
        to: NOW - 3_000 + 300,
        tradingHoursTemplate: "cme_us_index_futures_eth",
      },
      expect.any(Number),
    );
  });

  it("refuses a gap entirely older than the per-TF heal window", async () => {
    const deps = makeDeps();
    const healer = new GapHealer(deps);
    const old = NOW - HEAL_MAX_WINDOW_SECS["15s"] - 7_200;
    const res = await healer.heal(
      gap({ timeframe: "15s", fromTs: old, toTs: old + 60 }),
    );
    expect(res.requested).toBe(false);
    expect(res.reason).toMatch(/exceeds heal window/i);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("clamps a partially-old gap's from to the window edge", async () => {
    const deps = makeDeps();
    const healer = new GapHealer(deps);
    const edge = NOW - HEAL_MAX_WINDOW_SECS["5m"];
    await healer.heal(gap({ fromTs: edge - 86_400, toTs: NOW - 600 }));
    const payload = (deps.request as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      from: number;
    };
    expect(payload.from).toBeGreaterThanOrEqual(edge);
  });

  it("allows only one in-flight heal per stream, freeing the slot after settle", async () => {
    let resolveFirst!: () => void;
    let calls = 0;
    const request = vi.fn(() => {
      calls++;
      if (calls === 1) {
        return new Promise<unknown>((resolve) => { resolveFirst = () => resolve({}); });
      }
      return Promise.resolve({});
    });
    const healer = new GapHealer(makeDeps({ request }));
    const p1 = healer.heal(gap());
    const r2 = await healer.heal(gap());
    expect(r2.requested).toBe(false);
    expect(r2.reason).toMatch(/in flight/i);
    expect(healer.healsInFlight()).toBe(1);
    resolveFirst();
    await p1;
    expect(healer.healsInFlight()).toBe(0);
    const r3 = await healer.heal(gap());
    expect(r3.requested).toBe(true);
  });

  it("frees the slot when the request rejects and reports the failure", async () => {
    const request = vi.fn(async () => {
      throw new Error("boom");
    });
    const healer = new GapHealer(makeDeps({ request }));
    const res = await healer.heal(gap());
    expect(res.requested).toBe(false);
    expect(res.reason).toMatch(/boom/);
    expect(healer.healsInFlight()).toBe(0);
  });

  it("contains a synchronously-throwing request (real disconnected shape)", async () => {
    const request = vi.fn(() => {
      throw new Error("bridge not connected");
    }) as unknown as HealDeps["request"];
    const healer = new GapHealer(makeDeps({ request }));
    const res = await healer.heal(gap());
    expect(res.requested).toBe(false);
    expect(healer.healsInFlight()).toBe(0);
  });
});
