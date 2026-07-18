import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeSchema } from "../../db/schema.js";
import { createLiveFeedRuntime, type LiveFeedRuntimeDeps } from "../runtime.js";
import { MCP_SOURCE } from "../registry.js";
import type {
  BarCloseMessage,
  HelloMessage,
  SubscribeAckMessage,
} from "../../bridge/protocol.js";

const unix = (y: number, mo1: number, d: number, h: number, mi = 0): number =>
  Math.floor(Date.UTC(y, mo1 - 1, d, h, mi, 0) / 1000);

// NQ session-day 2026-05-01 (Fri): Apr 30 18:00 EDT → May 1 17:00 EDT.
const DAY_START = unix(2026, 4, 30, 22);
const DAY_END = DAY_START + 82_800;
const t5 = (i: number): number => DAY_START + i * 300;

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function seedCandles(db: Database.Database, stamps: number[]) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES ('NQ', '5m', ?, 100, 101, 99, 100.5, 10)`,
  );
  for (const ts of stamps) stmt.run(ts);
}

function ack(over: Partial<SubscribeAckMessage> = {}): SubscribeAckMessage {
  return {
    v: 1, id: "a", type: "subscribe_ack", symbol: "NQ", timeframe: "5m",
    contract: "NQ 09-26", seedCount: 30, seedLastTs: t5(1), alreadyActive: false,
    ...over,
  };
}

function hello(over: Partial<HelloMessage> = {}): HelloMessage {
  return { v: 1, type: "hello", ntVersion: "NT8", instruments: ["NQ"], ...over };
}

function barClose(ts: number): BarCloseMessage {
  return {
    v: 1, type: "bar_close", symbol: "NQ", timeframe: "5m",
    candle: { timestamp: ts, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
    seq: 1, contract: "NQ 09-26",
  };
}

function makeRuntime(over: Partial<LiveFeedRuntimeDeps> = {}) {
  const db = over.db ?? memDb();
  const deps: LiveFeedRuntimeDeps = {
    db,
    request: vi.fn(async (type: string) =>
      type === "subscribe_bars" ? ack() : {},
    ),
    isConnected: () => true,
    nowUnix: () => t5(10) + 60, // mid-session, just after stamp 10
    nowMs: () => (t5(10) + 60) * 1000,
    recorderDir: mkdtempSync(join(tmpdir(), "live-rt-")),
    onWarn: vi.fn(),
    ...over,
  };
  return { runtime: createLiveFeedRuntime(deps), deps, db };
}

describe("bar_close flow", () => {
  it("records, notes, then publishes — in that order", async () => {
    const { runtime } = makeRuntime();
    await runtime.registry.ensure("NQ", "5m", MCP_SOURCE);
    const calls: string[] = [];
    const recordSpy = vi.spyOn(runtime.recorder, "record").mockImplementation(() => {
      calls.push("record");
    });
    const noteSpy = vi.spyOn(runtime.registry, "noteBar").mockImplementation(() => {
      calls.push("note");
    });
    runtime.bus.subscribe(() => calls.push("publish"));
    runtime.handleBarClose(barClose(t5(2)));
    expect(calls).toEqual(["record", "note", "publish"]);
    recordSpy.mockRestore();
    noteSpy.mockRestore();
  });

  it("publishes the full event shape", () => {
    const { runtime } = makeRuntime();
    const events: unknown[] = [];
    runtime.bus.subscribe((e) => events.push(e));
    runtime.handleBarClose(barClose(t5(2)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      symbol: "NQ",
      timeframe: "5m",
      seq: 1,
      contract: "NQ 09-26",
      candle: { timestamp: t5(2) },
    });
  });

  it("an OHLC-invalid bar is dropped before the recorder, registry, and bus", () => {
    const { runtime } = makeRuntime();
    const events: unknown[] = [];
    runtime.bus.subscribe((e) => events.push(e));
    const glitched: BarCloseMessage = {
      v: 1, type: "bar_close", symbol: "NQ", timeframe: "5m",
      // high below the body — the exact shape ingest rejects
      candle: { timestamp: t5(2), open: 100, high: 99, low: 98, close: 100.5, volume: 10 },
      seq: 1,
    };
    runtime.handleBarClose(glitched);
    expect(events).toHaveLength(0);
    expect(runtime.recorder.recent({ limit: 10 })).toHaveLength(0);
    expect(runtime.registry.list().every((s) => s.lastTs === null)).toBe(true);
  });

  it("a throwing bus listener cannot break the flow", () => {
    const { runtime } = makeRuntime();
    runtime.bus.subscribe(() => {
      throw new Error("consumer bug");
    });
    const events: unknown[] = [];
    runtime.bus.subscribe((e) => events.push(e));
    expect(() => runtime.handleBarClose(barClose(t5(2)))).not.toThrow();
    expect(events).toHaveLength(1);
  });

  it("a detected gap triggers the healer", async () => {
    const { runtime, deps } = makeRuntime();
    runtime.handleBarClose(barClose(t5(1)));
    runtime.handleBarClose(barClose(t5(4)));
    await vi.waitFor(() => {
      expect(deps.request).toHaveBeenCalledWith(
        "request_candles",
        expect.objectContaining({ from: t5(2) - 300, to: t5(3) + 300 }),
        expect.any(Number),
      );
    });
  });
});

describe("hello handling", () => {
  it("warns on a non-Eastern timezone and stays quiet on Eastern", async () => {
    const onWarn = vi.fn();
    const { runtime } = makeRuntime({ onWarn });
    await runtime.handleHello(hello({ timeZone: "Pacific Standard Time" }));
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/Pacific/));
    onWarn.mockClear();
    await runtime.handleHello(hello({ timeZone: "Eastern Standard Time" }));
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("replays subscriptions on hello", async () => {
    const { runtime, deps } = makeRuntime();
    await runtime.registry.ensure("NQ", "5m", MCP_SOURCE);
    (deps.request as ReturnType<typeof vi.fn>).mockClear();
    await runtime.handleHello(hello());
    expect(deps.request).toHaveBeenCalledWith(
      "subscribe_bars",
      expect.objectContaining({ symbol: "NQ", timeframe: "5m" }),
      expect.any(Number),
    );
  });

  it("late subscribe_ack reconciles registry state", async () => {
    const request = vi.fn(async (type: string) => {
      if (type === "subscribe_bars") throw new Error("timed out");
      return {};
    });
    const { runtime } = makeRuntime({ request });
    await runtime.registry.ensure("NQ", "5m", MCP_SOURCE);
    expect(runtime.registry.list()[0].acked).toBe(false);
    runtime.handleSubscribeAck(ack());
    expect(runtime.registry.list()[0].acked).toBe(true);
  });

  it("catch-up: exactly one missing adjacent bar heals with fromTs === toTs, never NaN", async () => {
    const db = memDb();
    // Cache through stamp 9; now is just past stamp 10 → stamp 10 is closed+missing.
    seedCandles(db, [t5(8), t5(9)]);
    const { runtime, deps } = makeRuntime({ db });
    await runtime.registry.ensure("NQ", "5m", MCP_SOURCE);
    (deps.request as ReturnType<typeof vi.fn>).mockClear();
    await runtime.handleHello(hello());
    const healCall = (deps.request as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "request_candles",
    );
    expect(healCall).toBeDefined();
    const payload = healCall![1] as { from: number; to: number };
    expect(payload.from).toBe(t5(10) - 300);
    expect(payload.to).toBe(t5(10) + 300);
    expect(Number.isFinite(payload.from)).toBe(true);
  });

  it("catch-up: hello on a closed Saturday heals Friday's tail via the fallback anchor", async () => {
    const db = memDb();
    seedCandles(db, [t5(270)]); // stale: 6 bars before Friday close
    const saturdayNoon = unix(2026, 5, 2, 12);
    const { runtime, deps } = makeRuntime({
      db,
      nowUnix: () => saturdayNoon,
      nowMs: () => saturdayNoon * 1000,
    });
    await runtime.registry.ensure("NQ", "5m", MCP_SOURCE);
    (deps.request as ReturnType<typeof vi.fn>).mockClear();
    await runtime.handleHello(hello());
    const healCall = (deps.request as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "request_candles",
    );
    expect(healCall).toBeDefined();
    const payload = healCall![1] as { from: number; to: number };
    expect(payload.from).toBe(t5(271) - 300);
    expect(payload.to).toBe(DAY_END + 300);
  });

  it("catch-up: an empty cache is skipped entirely", async () => {
    const { runtime, deps } = makeRuntime();
    await runtime.registry.ensure("NQ", "5m", MCP_SOURCE);
    (deps.request as ReturnType<typeof vi.fn>).mockClear();
    await runtime.handleHello(hello());
    const healCalls = (deps.request as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "request_candles",
    );
    expect(healCalls).toHaveLength(0);
  });

  it("catch-up: an up-to-date cache heals nothing", async () => {
    const db = memDb();
    seedCandles(db, [t5(9), t5(10)]); // stamp 10 = latest closed at now
    const { runtime, deps } = makeRuntime({ db });
    await runtime.registry.ensure("NQ", "5m", MCP_SOURCE);
    (deps.request as ReturnType<typeof vi.fn>).mockClear();
    await runtime.handleHello(hello());
    const healCalls = (deps.request as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "request_candles",
    );
    expect(healCalls).toHaveLength(0);
  });
});
