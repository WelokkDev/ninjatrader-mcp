import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeSchema } from "../../db/schema.js";
import { createLiveFeedRuntime, type LiveFeedRuntime } from "../../live/runtime.js";
import {
  createSubscribeLiveBarsHandler,
  createUnsubscribeLiveBarsHandler,
  createLiveFeedStatusHandler,
  type LiveFeedToolsDeps,
} from "../live-feed.js";
import type { SubscribeAckMessage, BarCloseMessage } from "../../bridge/protocol.js";
import { getInstrumentConfig } from "../../core/sessions/registry.js";
import { loadCalendar } from "../../core/sessions/calendar.js";
import { sessionDayAtOrBefore, sessionDayContaining } from "../../core/sessions/session-day.js";

const NOW = 1_789_000_000;

function ack(): SubscribeAckMessage {
  return {
    v: 1, id: "a", type: "subscribe_ack", symbol: "NQ", timeframe: "5m",
    contract: "NQ 09-26", seedCount: 30, seedLastTs: NOW - 300, alreadyActive: false,
  };
}

function makeRuntime(over: { request?: ReturnType<typeof vi.fn>; connected?: boolean } = {}): LiveFeedRuntime {
  const db = new Database(":memory:");
  initializeSchema(db);
  return createLiveFeedRuntime({
    db,
    request: (over.request ?? vi.fn(async () => ack())) as never,
    isConnected: () => over.connected ?? true,
    nowUnix: () => NOW,
    nowMs: () => NOW * 1000,
    recorderDir: mkdtempSync(join(tmpdir(), "live-tools-")),
    onWarn: () => {},
  });
}

function makeDeps(runtime: LiveFeedRuntime | null): LiveFeedToolsDeps {
  return {
    runtime: () => runtime,
    bridgeStatus: () => ({
      connected: true,
      connectedSince: NOW - 100,
      lastHeartbeatAt: NOW - 1,
      ntVersion: "NT8",
      instruments: ["NQ"],
      caps: null,
      pendingRequests: 0,
      listening: true,
      port: 9472,
    }),
    consumerCount: () => 2,
    source: "mcp",
  };
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe("subscribe_live_bars", () => {
  it("errors cleanly when the live runtime is not started", async () => {
    const handler = createSubscribeLiveBarsHandler(makeDeps(null));
    const res = await handler({ symbol: "NQ", timeframe: "5m" });
    const out = parse(res);
    expect(res.isError).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/runtime not started/i);
  });

  it("returns the truthful ack fields on success", async () => {
    const handler = createSubscribeLiveBarsHandler(makeDeps(makeRuntime()));
    const out = parse(await handler({ symbol: "NQ", timeframe: "5m" }));
    expect(out.ok).toBe(true);
    expect(out.acked).toBe(true);
    expect(out.contract).toBe("NQ 09-26");
  });

  it("surfaces upstream failure as ok:false with the error", async () => {
    const request = vi.fn(async () => {
      throw new Error("Request subscribe_bars (x) timed out after 15000ms");
    });
    const handler = createSubscribeLiveBarsHandler(makeDeps(makeRuntime({ request })));
    const res = await handler({ symbol: "NQ", timeframe: "5m" });
    const out = parse(res);
    expect(res.isError).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timed out/);
    expect(out.acked).toBe(false);
  });

  it("rejects an unknown symbol", async () => {
    const handler = createSubscribeLiveBarsHandler(makeDeps(makeRuntime()));
    const out = parse(await handler({ symbol: "ZZZ", timeframe: "5m" }));
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
});

describe("unsubscribe_live_bars", () => {
  it("releases the mcp source and reports upstream removal", async () => {
    const runtime = makeRuntime();
    const subscribe = createSubscribeLiveBarsHandler(makeDeps(runtime));
    await subscribe({ symbol: "NQ", timeframe: "5m" });
    const handler = createUnsubscribeLiveBarsHandler(makeDeps(runtime));
    const out = parse(await handler({ symbol: "NQ", timeframe: "5m" }));
    expect(out.ok).toBe(true);
    expect(out.removedUpstream).toBe(true);
    expect(runtime.registry.list()).toHaveLength(0);
  });

  it("errors cleanly when the runtime is not started", async () => {
    const handler = createUnsubscribeLiveBarsHandler(makeDeps(null));
    const out = parse(await handler({ symbol: "NQ", timeframe: "5m" }));
    expect(out.ok).toBe(false);
  });
});

describe("live_feed_status", () => {
  it("merges registry and recorder rows, and includes bridge/consumer/heal info", async () => {
    const runtime = makeRuntime();
    const subscribe = createSubscribeLiveBarsHandler(makeDeps(runtime));
    await subscribe({ symbol: "NQ", timeframe: "5m" });
    const bar: BarCloseMessage = {
      v: 1, type: "bar_close", symbol: "NQ", timeframe: "5m",
      candle: { timestamp: NOW - 300, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
      seq: 4, contract: "NQ 09-26",
    };
    runtime.handleBarClose(bar);

    const handler = createLiveFeedStatusHandler(makeDeps(runtime));
    const out = parse(await handler({}));
    expect(out.consumers).toBe(2);
    expect((out.bridge as { connected: boolean }).connected).toBe(true);
    expect(out.healsInFlight).toBe(0);
    const subs = out.subscriptions as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      symbol: "NQ",
      timeframe: "5m",
      acked: true,
      contract: "NQ 09-26",
      lastSeq: 4,
      barsReceived: 1,
      gapCount: 0,
    });
  });

  it("reports an empty-but-valid shape with no runtime", async () => {
    const handler = createLiveFeedStatusHandler(makeDeps(null));
    const res = await handler({});
    const out = parse(res);
    expect(res.isError).toBe(true);
    expect(out.error).toMatch(/runtime not started/i);
    expect(out.bridge).toBeDefined();
  });
});

describe("per-session sources", () => {
  it("two sessions hold one upstream stream; one leaving does not end the other's", async () => {
    const request = vi.fn(async () => ack());
    const runtime = makeRuntime({ request });
    const a = { ...makeDeps(runtime), source: "mcp:a" };
    const b = { ...makeDeps(runtime), source: "mcp:b" };
    await createSubscribeLiveBarsHandler(a)({ symbol: "NQ", timeframe: "5m" });
    await createSubscribeLiveBarsHandler(b)({ symbol: "NQ", timeframe: "5m" });
    expect(request).toHaveBeenCalledTimes(1);

    const out = parse(await createUnsubscribeLiveBarsHandler(a)({ symbol: "NQ", timeframe: "5m" }));
    expect(out.removedUpstream).toBe(false);
    expect(runtime.registry.list()[0].sources).toEqual(["mcp:b"]);
  });
});

describe("live_feed_status contract check", () => {
  function cacheWithFront(contract: string): { db: Database.Database; label: string } {
    const db = new Database(":memory:");
    initializeSchema(db);
    const config = getInstrumentConfig("NQ");
    const day = sessionDayContaining(NOW, config.session, loadCalendar(db, config.session.name));
    if (!day) throw new Error("fixture NOW falls outside every NQ session");
    db.prepare(
      `INSERT INTO session_contracts
         (symbol, session_day, start_unix, end_unix, contract, decided_by, updated_at)
       VALUES ('NQ', ?, ?, ?, ?, 'fetch', ?)`,
    ).run(day.label, day.startUnix, day.endUnix, contract, NOW);
    return { db, label: day.label };
  }

  it("flags a subscription bound off the day's front contract and lists today's disputes", async () => {
    const runtime = makeRuntime();
    await createSubscribeLiveBarsHandler(makeDeps(runtime))({ symbol: "NQ", timeframe: "5m" });
    const { db, label } = cacheWithFront("NQ 12-26");
    db.prepare(
      `INSERT INTO contract_events
         (symbol, session_day, kind, from_contract, to_contract, first_ts, last_ts, count, detail)
       VALUES ('NQ', ?, 'off_front', 'NQ 12-26', 'NQ 09-26', ?, ?, 12, '5m live')`,
    ).run(label, NOW, NOW);

    const handler = createLiveFeedStatusHandler({ ...makeDeps(runtime), db, nowUnix: () => NOW });
    const out = parse(await handler({}));
    const subs = out.subscriptions as Array<Record<string, unknown>>;
    expect(subs[0]).toMatchObject({ contract: "NQ 09-26", frontContract: "NQ 12-26", offFront: true });
    expect(out.contractNotes).toEqual([
      expect.stringMatching(/12 bar\(s\) arrived under NQ 09-26 while the front contract is NQ 12-26/),
    ]);
  });

  it("still answers after the session closes: the weekend shows Friday's front", async () => {
    const runtime = makeRuntime();
    await createSubscribeLiveBarsHandler(makeDeps(runtime))({ symbol: "NQ", timeframe: "5m" });
    const saturday = Math.floor(Date.UTC(2026, 8, 12, 12) / 1000);
    const db = new Database(":memory:");
    initializeSchema(db);
    const config = getInstrumentConfig("NQ");
    const friday = sessionDayAtOrBefore(saturday, config.session, loadCalendar(db, config.session.name));
    expect(friday?.label).toBe("2026-09-11");
    db.prepare(
      `INSERT INTO session_contracts
         (symbol, session_day, start_unix, end_unix, contract, decided_by, updated_at)
       VALUES ('NQ', '2026-09-11', ?, ?, 'NQ 12-26', 'fetch', ?)`,
    ).run(friday?.startUnix, friday?.endUnix, saturday);

    const handler = createLiveFeedStatusHandler({
      ...makeDeps(runtime), db, nowUnix: () => saturday,
    });
    const subs = parse(await handler({})).subscriptions as Array<Record<string, unknown>>;
    expect(subs[0]).toMatchObject({ frontContract: "NQ 12-26", offFront: true });
  });

  it("reports the front quietly when the subscription matches it", async () => {
    const runtime = makeRuntime();
    await createSubscribeLiveBarsHandler(makeDeps(runtime))({ symbol: "NQ", timeframe: "5m" });
    const { db } = cacheWithFront("NQ SEP26"); // NT8's other spelling of the same contract
    const handler = createLiveFeedStatusHandler({ ...makeDeps(runtime), db, nowUnix: () => NOW });
    const out = parse(await handler({}));
    const subs = out.subscriptions as Array<Record<string, unknown>>;
    expect(subs[0]).toMatchObject({ contract: "NQ 09-26", frontContract: "NQ SEP26" });
    expect(subs[0]).not.toHaveProperty("offFront");
    expect(out).not.toHaveProperty("contractNotes");
  });
});
