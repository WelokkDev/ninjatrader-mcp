import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lab } from "./lab/lab.js";
import { startBridge, stopBridge } from "./bridge/index.js";
import {
  registerCandlesResponseHandler,
  registerLiveIngestHandler,
} from "./bridge/ingest.js";
import { registerCalendarSyncOnHello } from "./bridge/calendar-sync.js";

import { registerGetCandles } from "./tools/get-candles.js";
import { registerResolveSessionDays } from "./tools/resolve-session-days.js";
import { registerPrefetchTools } from "./tools/prefetch-candles.js";
import { registerDraw } from "./tools/draw.js";
import { registerDrawZone } from "./tools/draw-zone.js";
import { registerClearZones } from "./tools/clear-zones.js";
import { registerListOpenCharts } from "./tools/list-open-charts.js";
import {
  registerSubscribeLiveBars,
  registerUnsubscribeLiveBars,
  registerLiveFeedStatus,
} from "./tools/live-feed.js";
import { startLiveFeedRuntime } from "./live/runtime.js";
import { registerListTrades } from "./tools/list-trades.js";
import { registerListDecisions } from "./tools/list-decisions.js";
import { registerGetTrades, registerSyncTrades } from "./tools/get-trades.js";
import { registerStartExperiment } from "./tools/start-experiment.js";
import { registerExperimentStatus } from "./tools/experiment-status.js";
import { registerExperimentResult } from "./tools/experiment-result.js";
import { registerListExperiments } from "./tools/list-experiments.js";
import { registerDiffExperiments } from "./tools/diff-experiments.js";

// The composition seam. A private bin (src/private/) imports these to boot the
// whole public surface with one call each, then registers its own tools on top.
// Public code never imports from src/private/ — the dependency is one-way.

/**
 * Every generic tool — the full public surface minus anything runner-gated.
 *
 * `except` skips the stock registration for the named tools so a private bin
 * can register its own replacement under the same name (the MCP SDK rejects
 * duplicate tool names, so skip-then-register is the override mechanism).
 * Note: the three prefetch_* tools share one registration — excluding any of
 * them excludes all three.
 */
export function registerGenericTools(
  server: McpServer,
  opts: { except?: string[] } = {},
): void {
  const skip = new Set(opts.except ?? []);
  const unless = (names: string[], register: () => void): void => {
    if (names.some((n) => skip.has(n))) return;
    register();
  };
  unless(["get_candles"], () => registerGetCandles(server));
  unless(["resolve_session_days"], () => registerResolveSessionDays(server));
  unless(["prefetch_candles", "prefetch_status", "prefetch_cancel"], () =>
    registerPrefetchTools(server),
  );
  unless(["draw"], () => registerDraw(server));
  unless(["draw_zone"], () => registerDrawZone(server));
  unless(["clear_zones"], () => registerClearZones(server));
  unless(["list_open_charts"], () => registerListOpenCharts(server));
  unless(["subscribe_live_bars"], () => registerSubscribeLiveBars(server));
  unless(["unsubscribe_live_bars"], () => registerUnsubscribeLiveBars(server));
  unless(["live_feed_status"], () => registerLiveFeedStatus(server));
  unless(["list_trades"], () => registerListTrades(server));
  unless(["list_decisions"], () => registerListDecisions(server));
  unless(["get_trades"], () => registerGetTrades(server));
  unless(["sync_trades"], () => registerSyncTrades(server));
}

/**
 * Strategy Lab — async experiment orchestration + observability. Runner-gated:
 * only meaningful when the caller can supply a Lab bound to a backtest engine.
 */
export function registerExperimentTools(server: McpServer, lab: Lab): void {
  registerStartExperiment(server, lab);
  registerExperimentStatus(server, lab);
  registerExperimentResult(server, lab);
  registerListExperiments(server, lab);
  registerDiffExperiments(server, lab);
}

/** NT8 bridge + live/candles ingest + calendar sync. Run exactly one process. */
export async function startRuntime(): Promise<void> {
  await startBridge();
  // Ingest must register before the live runtime: bar_close persists to the
  // cache before the feed bus publishes (read-your-writes for /feed).
  registerLiveIngestHandler();
  registerCandlesResponseHandler();
  registerCalendarSyncOnHello();
  startLiveFeedRuntime();
}

export async function stopRuntime(): Promise<void> {
  await stopBridge();
}
