import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getLiveFeedRuntime } from "../live/runtime.js";
import { PERSISTED_SOURCE, type LiveSubState } from "../live/registry.js";
import type { PrefetchJobSnapshot } from "../core/cache/prefetch.js";
import { prefetchManager } from "../prefetch-instance.js";
import type { BuildFingerprint } from "../hub/config.js";
import type { Hub } from "../hub/daemon.js";
import { jsonResult, type ToolResult } from "./result.js";
import type { SessionContext } from "./session.js";

export interface ListSessionsDeps {
  me: SessionContext;
  hub: Pick<Hub, "sessions" | "health">;
  subscriptions: () => LiveSubState[];
  prefetchJobs: () => PrefetchJobSnapshot[];
  buildOnDisk: () => BuildFingerprint;
  nowMs?: () => number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function createListSessionsHandler(deps: ListSessionsDeps) {
  return async (): Promise<ToolResult> => {
    const now = deps.nowMs ? deps.nowMs() : Date.now();
    const subs = deps.subscriptions();
    const jobs = deps.prefetchJobs().filter((j) => j.state === "running");

    const sessions = deps.hub
      .sessions()
      .map((s) => ({
        id: s.id,
        me: s.id === deps.me.id,
        connectedAt: iso(s.connectedAtMs),
        idleSeconds: Math.max(0, Math.round((now - s.lastSeenMs) / 1000)),
        attached: s.attached,
        subscriptions: subs.filter((x) => x.sources.includes(s.source)).map((x) => `${x.symbol}:${x.timeframe}`),
        prefetchJobs: jobs.filter((j) => j.owner === s.source).map((j) => j.jobId),
        drawings: s.drawings,
      }))
      .sort((a, b) => (a.me === b.me ? a.connectedAt.localeCompare(b.connectedAt) : a.me ? -1 : 1));

    const health = deps.hub.health();
    const onDisk = deps.buildOnDisk();
    const stale = onDisk.newestMtimeMs > health.build.newestMtimeMs + 1_000;

    return jsonResult({
      me: deps.me.id,
      hub: {
        pid: health.pid,
        port: health.port,
        startedAt: iso(health.startedAtMs),
        exitsWhenIdle: !health.resident,
        build: iso(health.build.newestMtimeMs),
        buildOnDisk: iso(onDisk.newestMtimeMs),
        stale,
      },
      ...(stale
        ? {
            warning:
              "The hub is running an older build than the one on disk; every session is on the old code. Run `npm stop` and reconnect to pick up the rebuild.",
          }
        : {}),
      sessions,
      persistedSubscriptions: subs
        .filter((x) => x.sources.includes(PERSISTED_SOURCE))
        .map((x) => `${x.symbol}:${x.timeframe}`),
    });
  };
}

export function registerListSessions(
  server: McpServer,
  session: SessionContext,
  { hub, buildOnDisk }: Pick<ListSessionsDeps, "hub" | "buildOnDisk">,
): void {
  server.tool(
    "list_sessions",
    "Every conversation attached to this hub right now and what each one holds: live bar subscriptions, running prefetch jobs, drawings, idle time, and whether its event stream is attached. `me` marks this conversation. Also reports the hub process (pid, port, started, whether it exits when idle) and whether it is serving an older build than the one on disk — if `stale` is true, `npm stop` and reconnect. Subscriptions under persistedSubscriptions survive every session and restart until unsubscribed explicitly.",
    {},
    createListSessionsHandler({
      me: session,
      hub,
      subscriptions: () => getLiveFeedRuntime()?.registry.list() ?? [],
      prefetchJobs: () => prefetchManager.status().jobs,
      buildOnDisk,
    }),
  );
}
