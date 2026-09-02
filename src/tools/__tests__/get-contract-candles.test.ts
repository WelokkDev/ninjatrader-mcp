import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { createGetContractCandlesHandler } from "../get-contract-candles.js";
import type { Timeframe } from "../../core/types.js";

// Bypasses front-month resolution and never reaches SQLite; both are pinned.

function memDb() {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

function bars(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ timestamp: 1_780_000_000 + i * 900, open: 1, high: 2, low: 0, close: 1.5, volume: 7 });
  }
  return out;
}

function reply(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: "x",
    type: "candles_response",
    symbol: "NQ",
    timeframe: "15m",
    candles: bars(3),
    dataSource: "My Broker Feed",
    priceBasis: "as_traded",
    mergePolicy: "MergeNonBackAdjusted",
    contract: "NQ SEP26",
    pinned: true,
    ...over,
  };
}

function handler(request = vi.fn().mockResolvedValue(reply()), isConnected = () => true) {
  return {
    run: createGetContractCandlesHandler({ db: memDb(), isConnected, request }),
    request,
  };
}

const ARGS = {
  symbol: "NQ",
  contract: "NQ SEP26",
  timeframe: "15m" as Timeframe,
  start: "2026-08-27",
  end: "2026-08-28",
};

const text = (r: { content: Array<{ text?: string }> }) => String(r.content[0]?.text ?? "");

describe("get_contract_candles", () => {
  it("sends the pinned contract on the wire, alongside the bare symbol", async () => {
    const h = handler();
    await h.run(ARGS);
    expect(h.request).toHaveBeenCalledTimes(1);
    const [type, payload] = h.request.mock.calls[0];
    expect(type).toBe("request_candles");
    // The bare symbol still selects the session template; the contract pins NT8.
    expect(payload).toMatchObject({
      symbol: "NQ",
      contract: "NQ SEP26",
      timeframe: "15m",
      tradingHoursTemplate: "cme_us_index_futures_eth",
    });
  });

  it("returns the bars and marks them uncached", async () => {
    const h = handler();
    const res = await h.run(ARGS);
    const body = JSON.parse(text(res as never));
    expect(body.count).toBe(3);
    expect(body.cached).toBe(false);
    expect(body.contract).toBe("NQ SEP26");
  });

  it("refuses when the AddOn ignored the pin — an old build answers the front month", async () => {
    const h = handler(vi.fn().mockResolvedValue(reply({ pinned: undefined })));
    const res = await h.run(ARGS);
    expect(text(res as never)).toContain("ignored the pinned contract");
  });

  it("refuses when NT8 bound a different contract than the one asked for", async () => {
    const h = handler(vi.fn().mockResolvedValue(reply({ contract: "NQ DEC26" })));
    const res = await h.run(ARGS);
    const t = text(res as never);
    expect(t).toContain("NQ SEP26");
    expect(t).toContain("NQ DEC26");
  });

  it("refuses a derived timeframe rather than serving a differently-built bar", async () => {
    const h = handler();
    const res = await h.run({ ...ARGS, timeframe: "1h" as Timeframe });
    expect(text(res as never)).toContain("derived from 15m");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("refuses an unsupported symbol and a disconnected bridge without calling NT8", async () => {
    const bad = handler();
    expect(text((await bad.run({ ...ARGS, symbol: "NQ SEP26" })) as never)).toContain(
      "Unsupported symbol",
    );

    const off = handler(vi.fn(), () => false);
    expect(text((await off.run(ARGS)) as never)).toContain("not connected");
    expect(off.request).not.toHaveBeenCalled();
  });

  it("refuses a range wider than the uncached single-shot cap", async () => {
    const h = handler();
    const res = await h.run({ ...ARGS, start: "2026-08-03", end: "2026-08-28" });
    expect(text(res as never)).toContain("session-days");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("counts session-days, not wall-clock — a weekend-spanning week still fits", async () => {
    // Thu -> next Wed is 5 session-days but ~7 calendar days.
    const h = handler();
    const res = await h.run({ ...ARGS, start: "2026-08-27", end: "2026-09-02" });
    expect(text(res as never)).not.toContain("cap");
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("accepts the other spelling of the same contract in NT8's echo", async () => {
    const h = handler(vi.fn().mockResolvedValue(reply({ contract: "NQ SEP26" })));
    const res = await h.run({ ...ARGS, contract: "NQ 09-26" });
    const body = JSON.parse(text(res as never));
    expect(body.count).toBe(3);
  });

  it("refuses a contract belonging to another instrument", async () => {
    const h = handler();
    const res = await h.run({ ...ARGS, contract: "CL DEC26" });
    expect(text(res as never)).toContain("not a NQ contract");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("uses the timeframe-scaled candle timeout, not the 10s default", async () => {
    // 1s pins are ~83k bars a day; the 10s default guarantees a timeout.
    const h = handler();
    await h.run({ ...ARGS, timeframe: "1s" as Timeframe, limit: 100_000 });
    const timeoutMs = h.request.mock.calls[0][2];
    expect(timeoutMs).toBeGreaterThan(10_000);
  });

  it("refuses a nonsense limit rather than silently dropping bars", async () => {
    const h = handler();
    expect(text((await h.run({ ...ARGS, limit: -1 })) as never)).toContain("positive integer");
    expect(h.request).not.toHaveBeenCalled();
  });
});
