import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isConnected as defaultIsConnected } from "../bridge/index.js";
import {
  subscribeBars as defaultSubscribeBars,
  unsubscribeBars as defaultUnsubscribeBars,
} from "../live/subscribe.js";
import { liveBarRecorder, type LiveBarRecorder } from "../live/bar-recorder.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(obj: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

// Raw streamable TFs only (5m default, 15m). Higher TFs are derived, not streamed.
const TIMEFRAME = z.enum(["5m", "15m"]);
type LiveTf = z.infer<typeof TIMEFRAME>;

const NOT_CONNECTED =
  "NinjaTrader bridge not connected on 127.0.0.1:9472 — start NinjaTrader with the McpBridge AddOn, then retry.";

// ---------- subscribe_live_bars ----------
export interface SubscribeLiveBarsDeps {
  isConnected: () => boolean;
  subscribeBars: (symbol: string, timeframe: string) => boolean;
}

export function createSubscribeLiveBarsHandler(deps: SubscribeLiveBarsDeps) {
  return async ({ symbol, timeframe }: { symbol: string; timeframe: LiveTf }): Promise<ToolResult> => {
    if (!deps.isConnected()) return text({ ok: false, error: NOT_CONNECTED });
    let dispatched: boolean;
    try {
      dispatched = deps.subscribeBars(symbol, timeframe);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return text({ ok: false, error: `Cannot subscribe ${symbol} ${timeframe}: ${m}` });
    }
    return text({ ok: dispatched, action: "subscribe", symbol, timeframe });
  };
}

// ---------- unsubscribe_live_bars ----------
export interface UnsubscribeLiveBarsDeps {
  isConnected: () => boolean;
  unsubscribeBars: (symbol: string, timeframe: string) => boolean;
}

export function createUnsubscribeLiveBarsHandler(deps: UnsubscribeLiveBarsDeps) {
  return async ({ symbol, timeframe }: { symbol: string; timeframe: LiveTf }): Promise<ToolResult> => {
    if (!deps.isConnected()) return text({ ok: false, error: NOT_CONNECTED });
    const dispatched = deps.unsubscribeBars(symbol, timeframe);
    return text({ ok: dispatched, action: "unsubscribe", symbol, timeframe });
  };
}

// ---------- list_live_bars ----------
export interface ListLiveBarsDeps {
  recorder: Pick<LiveBarRecorder, "recent" | "subscriptions">;
}

export function createListLiveBarsHandler(deps: ListLiveBarsDeps) {
  return async ({ symbol, limit }: { symbol?: string; limit: number }): Promise<ToolResult> => {
    const bars = deps.recorder.recent({ symbol, limit });
    const activeSubscriptions = deps.recorder.subscriptions();
    const hint =
      bars.length === 0
        ? "No bars recorded yet — ensure subscribe_live_bars was called and a bar boundary has elapsed since."
        : undefined;
    return text({ count: bars.length, bars, activeSubscriptions, ...(hint ? { hint } : {}) });
  };
}

export function registerLiveFeedTools(server: McpServer): void {
  server.tool(
    "subscribe_live_bars",
    "Start streaming live CLOSED bars for a futures symbol from NinjaTrader into the local diagnostic recorder. Bars arrive once per timeframe close (every 5 minutes for 5m) and are appended to data/diagnostics/*.jsonl plus an in-memory buffer readable via list_live_bars. Idempotent on the NT side. Requires NinjaTrader connected with the McpBridge AddOn.",
    {
      symbol: z.string().min(1).describe("Futures symbol, e.g. MNQ, NQ, ES"),
      timeframe: TIMEFRAME.default("5m").describe("Raw bar timeframe to stream: 5m (default, the strategy entry TF) or 15m"),
    },
    createSubscribeLiveBarsHandler({ isConnected: defaultIsConnected, subscribeBars: defaultSubscribeBars }),
  );

  server.tool(
    "unsubscribe_live_bars",
    "Stop streaming live bars for a symbol+timeframe started by subscribe_live_bars.",
    {
      symbol: z.string().min(1).describe("Futures symbol to stop streaming"),
      timeframe: TIMEFRAME.default("5m").describe("Timeframe to stop: 5m or 15m"),
    },
    createUnsubscribeLiveBarsHandler({ isConnected: defaultIsConnected, unsubscribeBars: defaultUnsubscribeBars }),
  );

  server.tool(
    "list_live_bars",
    "Read back the most recently received live bars (newest first) plus per-subscription status: count, last-received close timestamp, last lag in seconds, and duplicate count. Read-only diagnostic to verify the live feed is flowing and fresh. Populated by subscribe_live_bars.",
    {
      symbol: z.string().min(1).optional().describe("Filter to one symbol; omit for all"),
      limit: z.number().int().min(1).max(500).default(20).describe("Max bars to return, newest first (default 20)"),
    },
    createListLiveBarsHandler({ recorder: liveBarRecorder }),
  );
}
