import { describe, it, expect } from "vitest";
import { createListSessionsHandler, type ListSessionsDeps } from "../list-sessions.js";
import { createSession } from "../session.js";
import type { LiveSubState } from "../../live/registry.js";
import type { PrefetchJobSnapshot } from "../../core/cache/prefetch.js";

const T0 = 1_789_000_000_000;

function sub(symbol: string, timeframe: string, sources: string[]): LiveSubState {
  return {
    symbol, timeframe: timeframe as LiveSubState["timeframe"], sources, acked: true, contract: null,
    lastSeq: null, lastTs: null, lastError: null, subscribedAt: 1, ackedAt: 2,
  };
}

function job(jobId: string, owner: string, state: PrefetchJobSnapshot["state"] = "running"): PrefetchJobSnapshot {
  return {
    jobId, owner, symbol: "NQ", timeframe: "15m", state, daysTotal: 1, alreadyComplete: 0, fetched: 0, failed: 0,
    pending: 1, cancelled: 0, currentDay: null, inProgressDays: [], expectedBarsToFetch: 1, etaSecs: null,
    failures: [], createdAt: 1, finishedAt: null,
  };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("list_sessions", () => {
  it("groups what each session holds and flags a stale build", async () => {
    const a = createSession("aaaa", T0 - 60_000);
    const b = createSession("bbbb", T0 - 30_000);
    const deps: ListSessionsDeps = {
      me: b,
      hub: {
        sessions: () => [
          { id: a.id, source: a.source, connectedAtMs: a.connectedAtMs, lastSeenMs: T0 - 5_000, attached: true, drawings: 1 },
          { id: b.id, source: b.source, connectedAtMs: b.connectedAtMs, lastSeenMs: T0, attached: false, drawings: 0 },
        ],
        health: () => ({
          ok: true, name: "h", version: "0", pid: 7, port: 9474, startedAtMs: T0 - 120_000, ready: true,
          resident: false, sessions: 2, build: { newestMtimeMs: T0 - 100_000, files: 3 },
        }),
      },
      subscriptions: () => [sub("NQ", "5m", [a.source, "mcp:persisted"]), sub("ES", "5m", [b.source])],
      prefetchJobs: () => [job("pf-1", a.source), job("pf-2", b.source, "completed")],
      buildOnDisk: () => ({ newestMtimeMs: T0 - 10_000, files: 3 }),
      nowMs: () => T0,
    };
    const out = parse(await createListSessionsHandler(deps)());
    expect(out.me).toBe("bbbb");
    expect(out.hub).toMatchObject({ pid: 7, port: 9474, exitsWhenIdle: true, stale: true });
    expect(out.warning).toMatch(/npm stop/);
    expect(out.sessions.map((s: { id: string }) => s.id)).toEqual(["bbbb", "aaaa"]); // me first
    expect(out.sessions[1]).toMatchObject({
      id: "aaaa", me: false, idleSeconds: 5, attached: true,
      subscriptions: ["NQ:5m"], prefetchJobs: ["pf-1"], drawings: 1,
    });
    expect(out.sessions[0]).toMatchObject({ subscriptions: ["ES:5m"], prefetchJobs: [] });
    expect(out.persistedSubscriptions).toEqual(["NQ:5m"]);
  });
});
