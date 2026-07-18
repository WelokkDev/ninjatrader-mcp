import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import {
  isConnected as bridgeIsConnected,
  onMessage,
  request as bridgeRequest,
} from "../bridge/index.js";
import { getInstrumentConfig } from "../core/sessions/registry.js";
import { loadCalendar } from "../core/sessions/calendar.js";
import {
  sessionDayContaining,
  sessionDaysOverlapping,
} from "../core/sessions/session-day.js";
import { expectedRawGrid } from "../core/cache/purge.js";
import { isValidCandle } from "../bridge/ingest.js";
import type {
  BarCloseMessage,
  HelloMessage,
  SubscribeAckMessage,
} from "../bridge/protocol.js";
import { LiveSubscriptionRegistry, type LiveTimeframe } from "./registry.js";
import { LiveBarRecorder, missingStampsBetween } from "./recorder.js";
import { GapHealer, HEAL_MAX_WINDOW_SECS, TF_SECS } from "./heal.js";
import { LiveFeedBus } from "./bus.js";
import { consumerHub } from "../bridge/consumer.js";

export interface LiveFeedRuntimeDeps {
  db: Database;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  isConnected: () => boolean;
  nowUnix?: () => number;
  nowMs?: () => number;
  recorderDir?: string;
  onWarn?: (msg: string) => void;
}

export interface LiveFeedRuntime {
  registry: LiveSubscriptionRegistry;
  recorder: LiveBarRecorder;
  healer: GapHealer;
  bus: LiveFeedBus;
  handleBarClose(msg: BarCloseMessage): void;
  handleSubscribeAck(msg: SubscribeAckMessage): void;
  handleHello(msg: HelloMessage): Promise<void>;
}

export function createLiveFeedRuntime(deps: LiveFeedRuntimeDeps): LiveFeedRuntime {
  const warn = deps.onWarn ?? ((m: string): void => console.error(m));
  const nowUnix = deps.nowUnix ?? ((): number => Math.floor(Date.now() / 1000));

  const registry = new LiveSubscriptionRegistry({
    db: deps.db,
    request: deps.request,
    isConnected: deps.isConnected,
    nowUnix: deps.nowUnix,
  });
  const healer = new GapHealer({
    request: deps.request,
    isConnected: deps.isConnected,
    nowUnix: deps.nowUnix,
  });
  const bus = new LiveFeedBus();
  const recorder = new LiveBarRecorder({
    db: deps.db,
    dir: deps.recorderDir,
    nowMs: deps.nowMs,
    onGap: (gap) => {
      void healer.heal(gap).then((r) => {
        if (!r.requested) console.error(`[live-feed] gap heal declined: ${r.reason}`);
      });
    },
  });

  registry.loadPersisted();

  const handleBarClose = (msg: BarCloseMessage): void => {
    // Same gate as cache ingest: a bar too corrupt for the cache never
    // reaches the recorder, the registry cursor, or a /feed bot.
    if (!isValidCandle(msg.candle)) {
      console.error(
        `[live-feed] dropping invalid bar_close for ${msg.symbol} ${msg.timeframe}: ${JSON.stringify(msg.candle)}`,
      );
      return;
    }
    recorder.record(msg);
    registry.noteBar(msg);
    bus.publish({
      symbol: msg.symbol,
      timeframe: msg.timeframe,
      candle: msg.candle,
      ...(typeof msg.seq === "number" ? { seq: msg.seq } : {}),
      ...(msg.backfill ? { backfill: true } : {}),
      ...(msg.contract ? { contract: msg.contract } : {}),
      receivedAtMs: deps.nowMs ? deps.nowMs() : Date.now(),
    });
  };

  const handleSubscribeAck = (msg: SubscribeAckMessage): void => {
    registry.noteAck(msg);
  };

  const handleHello = async (msg: HelloMessage): Promise<void> => {
    if (msg.timeZone && !/eastern/i.test(msg.timeZone)) {
      warn(
        `[live-feed] NT8 reports timezone "${msg.timeZone}" but the bridge converts bar times as US Eastern — ` +
          `cached stamps for live bars will be shifted. Set NT8's timezone to Eastern (Tools → Options → General) ` +
          `or fix the conversion in mcp-bridge.cs before trusting live data.`,
      );
    }

    const replay = await registry.replayAll();
    if (replay.replayed + replay.failed > 0) {
      console.error(
        `[live-feed] hello replay: ${replay.replayed} re-subscribed, ${replay.failed} failed`,
      );
    }

    // Catch-up: heal between what the cache holds and the newest bar that
    // must exist by now. Falls back to the last completed session-day when
    // the market is closed (a restart-over-weekend still heals Friday's tail).
    for (const sub of registry.list()) {
      try {
        await catchUp(deps.db, sub.symbol, sub.timeframe, nowUnix(), healer);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[live-feed] catch-up ${sub.symbol}:${sub.timeframe} failed: ${m}`);
      }
    }
  };

  return { registry, recorder, healer, bus, handleBarClose, handleSubscribeAck, handleHello };
}

async function catchUp(
  db: Database,
  symbol: string,
  timeframe: LiveTimeframe,
  now: number,
  healer: GapHealer,
): Promise<void> {
  const row = db
    .prepare("SELECT MAX(timestamp) AS m FROM candles WHERE symbol = ? AND timeframe = ?")
    .get(symbol, timeframe) as { m: number | null };
  // Empty cache: nothing to anchor on — deep backfill is get_candles' job.
  if (row.m === null) return;
  const cacheMax = row.m;

  const config = getInstrumentConfig(symbol);
  const calendar = loadCalendar(db, config.session.name);
  let anchorDay = sessionDayContaining(now, config.session, calendar);
  if (!anchorDay) {
    const days = sessionDaysOverlapping(
      now - HEAL_MAX_WINDOW_SECS[timeframe],
      now,
      config.session,
      calendar,
    );
    if (days.length === 0) return;
    anchorDay = days[days.length - 1];
  }

  let latestExpected: number | null = null;
  for (const ts of expectedRawGrid(anchorDay, timeframe, config.session, calendar)) {
    if (ts <= now && (latestExpected === null || ts > latestExpected)) latestExpected = ts;
  }
  if (latestExpected === null || latestExpected <= cacheMax) return;

  // +one bar-width so latestExpected itself is included (strict-exclusive
  // bounds would drop the single-adjacent-bar case).
  const missing = missingStampsBetween(
    db,
    symbol,
    timeframe,
    cacheMax,
    latestExpected + TF_SECS[timeframe],
  );
  if (missing.length === 0) return;
  const res = await healer.heal({
    symbol,
    timeframe,
    fromTs: missing[0],
    toTs: missing[missing.length - 1],
  });
  if (!res.requested) {
    console.error(`[live-feed] catch-up heal declined: ${res.reason}`);
  }
}

let runtime: LiveFeedRuntime | null = null;

/**
 * Production wiring. Idempotent. MUST run after registerLiveIngestHandler():
 * handlers fire in registration order and sqlite is synchronous, so bars are
 * queryable via get_candles before the bus publishes (read-your-writes).
 */
export function startLiveFeedRuntime(): LiveFeedRuntime {
  if (runtime) return runtime;
  runtime = createLiveFeedRuntime({
    db: defaultDb,
    // request throws synchronously when disconnected; wrapping makes it a rejection.
    request: async (type, payload, timeoutMs) => bridgeRequest(type, payload, timeoutMs),
    isConnected: bridgeIsConnected,
  });
  onMessage("bar_close", (m) => runtime!.handleBarClose(m));
  onMessage("subscribe_ack", (m) => runtime!.handleSubscribeAck(m));
  onMessage("hello", (m) => {
    void runtime!.handleHello(m).catch((err) => {
      console.error("[live-feed] hello handling failed:", err);
    });
  });
  consumerHub.bind(
    {
      ensure: (symbol, tf, source) => runtime!.registry.ensure(symbol, tf, source),
      release: (symbol, tf, source) => runtime!.registry.release(symbol, tf, source),
      releaseAllForSource: (source) => runtime!.registry.releaseAllForSource(source),
      list: () => runtime!.registry.list(),
    },
    runtime.bus,
  );
  return runtime;
}

export function getLiveFeedRuntime(): LiveFeedRuntime | null {
  return runtime;
}
