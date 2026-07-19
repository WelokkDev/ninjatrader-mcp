import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBridgeStatus } from "../bridge/index.js";
import { consumerHub } from "../bridge/consumer.js";
import { getLiveFeedRuntime, type LiveFeedRuntime } from "../live/runtime.js";
import { MCP_SOURCE, type LiveTimeframe } from "../live/registry.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function json(obj: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

const LIVE_TF = z.enum(["15s", "5m", "15m"]);

const NOT_STARTED =
  "live feed runtime not started — startRuntime() has not run in this process";

export interface LiveFeedToolsDeps {
  runtime: () => LiveFeedRuntime | null;
  bridgeStatus: () => ReturnType<typeof getBridgeStatus>;
  consumerCount: () => number;
}

const defaultDeps: LiveFeedToolsDeps = {
  runtime: getLiveFeedRuntime,
  bridgeStatus: getBridgeStatus,
  consumerCount: () => consumerHub.count(),
};

export function createSubscribeLiveBarsHandler(deps: LiveFeedToolsDeps) {
  return async ({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: LiveTimeframe;
  }): Promise<ToolResult> => {
    const runtime = deps.runtime();
    if (!runtime) return json({ ok: false, error: NOT_STARTED });
    const res = await runtime.registry.ensure(symbol, timeframe, MCP_SOURCE);
    return json({
      ok: res.ok,
      symbol,
      timeframe,
      acked: res.state.acked,
      contract: res.state.contract,
      ...(res.error ? { error: res.error } : {}),
    });
  };
}

export function createUnsubscribeLiveBarsHandler(deps: LiveFeedToolsDeps) {
  return async ({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: LiveTimeframe;
  }): Promise<ToolResult> => {
    const runtime = deps.runtime();
    if (!runtime) return json({ ok: false, error: NOT_STARTED });
    const res = await runtime.registry.release(symbol, timeframe, MCP_SOURCE);
    return json({
      ok: true,
      symbol,
      timeframe,
      removedUpstream: res.removedUpstream,
      ...(res.pendingUpstreamRelease ? { pendingUpstreamRelease: true } : {}),
    });
  };
}

export function createLiveFeedStatusHandler(deps: LiveFeedToolsDeps) {
  return async (_args: Record<string, never>): Promise<ToolResult> => {
    const runtime = deps.runtime();
    if (!runtime) {
      return json({ error: NOT_STARTED, bridge: deps.bridgeStatus() });
    }
    const recorderByKey = new Map(
      runtime.recorder.status().map((s) => [`${s.symbol}:${s.timeframe}`, s]),
    );
    const subscriptions = runtime.registry.list().map((sub) => {
      const rec = recorderByKey.get(`${sub.symbol}:${sub.timeframe}`);
      return {
        symbol: sub.symbol,
        timeframe: sub.timeframe,
        sources: sub.sources,
        acked: sub.acked,
        contract: sub.contract,
        lastSeq: sub.lastSeq,
        lastTs: sub.lastTs,
        lastError: sub.lastError,
        barsReceived: rec?.count ?? 0,
        lastLagSeconds: rec?.lastLagSeconds ?? null,
        dupCount: rec?.dupCount ?? 0,
        outOfOrderCount: rec?.outOfOrderCount ?? 0,
        gapCount: rec?.gapCount ?? 0,
        lastGapAt: rec?.lastGapAt ?? null,
        seqJumps: rec?.seqJumps ?? 0,
      };
    });
    const pendingUnsubscribes = runtime.registry.pendingUnsubscribeKeys();
    return json({
      bridge: deps.bridgeStatus(),
      consumers: deps.consumerCount(),
      healsInFlight: runtime.healer.healsInFlight(),
      ...(pendingUnsubscribes.length > 0 ? { pendingUnsubscribes } : {}),
      subscriptions,
      // Position feed health (see subscribe_live_positions).
      positions: runtime.positions.status(),
    });
  };
}

export function registerSubscribeLiveBars(server: McpServer): void {
  server.tool(
    "subscribe_live_bars",
    "Start streaming live CLOSED bars for a futures symbol from NinjaTrader into the local candle cache — the same store get_candles reads, so live questions (latest close, current session bars) are answered by get_candles moments after each bar boundary. Returns the TRUTHFUL NT8-side result: ok/acked only when the AddOn confirmed the stream (with the resolved contract). Raw TFs only (5m default; 15m; 15s on demand — seconds history is shallow, use sparingly); 30m-4h derive automatically on 15m closes and are served by get_candles with forming bars marked partial. Subscriptions persist across server restarts and replay on every NT8 reconnect. Local bots can consume the same stream over ws://127.0.0.1:9472/feed.",
    {
      symbol: z.string().min(1).describe("Futures symbol, e.g. MNQ, NQ, ES"),
      timeframe: LIVE_TF.default("5m").describe(
        "Raw timeframe to stream: 5m (default), 15m, or 15s (on-demand only)",
      ),
    },
    createSubscribeLiveBarsHandler(defaultDeps),
  );
}

export function registerUnsubscribeLiveBars(server: McpServer): void {
  server.tool(
    "unsubscribe_live_bars",
    "Stop streaming live bars for a symbol+timeframe started by subscribe_live_bars. removedUpstream:false with pendingUpstreamRelease:true means the NT8-side release could not be confirmed yet (bridge down or request failed) — it retries automatically on the next NT8 reconnect; any other removedUpstream:false means another consumer (e.g. a /feed bot) still holds the stream.",
    {
      symbol: z.string().min(1).describe("Futures symbol to stop streaming"),
      timeframe: LIVE_TF.default("5m").describe("Timeframe to stop: 15s, 5m or 15m"),
    },
    createUnsubscribeLiveBarsHandler(defaultDeps),
  );
}

export function registerLiveFeedStatus(server: McpServer): void {
  server.tool(
    "live_feed_status",
    "Health of the live feeds. Bars: per-subscription truth (acked by NT8, resolved contract, last seq/timestamp, lag, bars received, duplicate/out-of-order/gap counters, last error) plus bridge connection state, connected /feed consumer count, and heals in flight. gapCount > 0 with healsInFlight 0 means a gap was detected and repaired (or exceeded the heal window — check get_candles for that range). Positions: the live position feed's health (desired vs NT8-acked, accounts tracked, open positions/trades, event/sync counters, seq gaps, last event/sync times, last error).",
    {},
    createLiveFeedStatusHandler(defaultDeps),
  );
}
