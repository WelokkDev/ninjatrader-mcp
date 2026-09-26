import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSession, drawingCount, type SessionContext } from "../tools/session.js";
import {
  HEALTH_PATH,
  HUB_HOST,
  MCP_PATH,
  SHUTDOWN_PATH,
  type BuildFingerprint,
  type HubHealth,
} from "./config.js";

const DEFAULT_DETACH_GRACE_MS = 15_000;
const STALE_SESSION_MS = 5 * 60_000;
const SWEEP_MS = 60_000;
/** A wall against a client looping on initialize. */
const DEFAULT_MAX_SESSIONS = 16;

export interface HubSpec {
  name: string;
  version: string;
  compose: (server: McpServer, session: SessionContext) => void;
  onSessionEnd: (session: SessionContext) => Promise<void>;
}

export interface HubOptions {
  port: number;
  token: string;
  resident: boolean;
  idleExitMs: number;
  holdOpen?: () => boolean;
  onIdleExit: () => void;
  onShutdownRequest?: () => void;
  build: BuildFingerprint;
  detachGraceMs?: number;
  maxSessions?: number;
  nowMs?: () => number;
  log?: (line: string) => void;
}

export interface SessionSummary {
  id: string;
  source: string;
  connectedAtMs: number;
  lastSeenMs: number;
  attached: boolean;
  drawings: number;
}

export interface Hub {
  port: number;
  setReady(): void;
  sessions(): SessionSummary[];
  health(): HubHealth;
  stop(): Promise<void>;
}

interface LiveSession {
  ctx: SessionContext;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeenMs: number;
  streams: number;
  detachTimer: NodeJS.Timeout | null;
  closed: boolean;
}

const short = (id: string): string => id.slice(0, 8);

export async function startHub(spec: HubSpec, opts: HubOptions): Promise<Hub> {
  const now = opts.nowMs ?? Date.now;
  const log = opts.log ?? ((line: string) => console.error(line));
  const detachGraceMs = opts.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, LiveSession>();
  const startedAtMs = now();
  const expected = Buffer.from(opts.token);
  let ready = false;
  let stopping = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let boundPort = opts.port;

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (!match) return false;
    const given = Buffer.from(match[1].trim());
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function health(): HubHealth {
    return {
      ok: true,
      name: spec.name,
      version: spec.version,
      pid: process.pid,
      port: boundPort,
      startedAtMs,
      ready,
      resident: opts.resident,
      sessions: sessions.size,
      build: opts.build,
    };
  }

  function clearIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleExit(): void {
    if (opts.resident || stopping || sessions.size > 0 || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (stopping || sessions.size > 0) return;
      if (opts.holdOpen?.()) {
        log("[hub] no sessions, but held open (a run still needs the bridge)");
        scheduleIdleExit();
        return;
      }
      log(`[hub] no sessions for ${Math.round(opts.idleExitMs / 1000)}s; exiting`);
      opts.onIdleExit();
    }, opts.idleExitMs);
  }

  async function closeSession(live: LiveSession, reason: string): Promise<void> {
    if (live.closed) return;
    live.closed = true;
    if (live.detachTimer) clearTimeout(live.detachTimer);
    const known = sessions.delete(live.ctx.id);
    try {
      await live.server.close();
    } catch (err) {
      log(`[hub] session ${short(live.ctx.id)} close error: ${text(err)}`);
    }
    if (known) {
      log(`[hub] session ${short(live.ctx.id)} closed: ${reason} (${sessions.size} attached)`);
      try {
        await spec.onSessionEnd(live.ctx);
      } catch (err) {
        log(`[hub] session ${short(live.ctx.id)} cleanup failed: ${text(err)}`);
      }
    }
    scheduleIdleExit();
  }

  async function openSession(): Promise<LiveSession> {
    // Minted here, not by the transport, so compose can bake it in before initialize.
    const id = randomUUID();
    const ctx = createSession(id, now());
    const live: LiveSession = {
      ctx,
      transport: null as unknown as StreamableHTTPServerTransport,
      server: null as unknown as McpServer,
      lastSeenMs: now(),
      streams: 0,
      detachTimer: null,
      closed: false,
    };
    live.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableDnsRebindingProtection: true,
      allowedHosts: [HUB_HOST, "localhost", `${HUB_HOST}:${boundPort}`, `localhost:${boundPort}`],
      onsessioninitialized: () => {
        sessions.set(id, live);
        clearIdleTimer();
        log(`[hub] session ${short(id)} opened (${sessions.size} attached)`);
      },
      onsessionclosed: () => void closeSession(live, "client ended the session"),
    });
    live.transport.onclose = () => void closeSession(live, "transport closed");
    live.server = new McpServer({ name: spec.name, version: spec.version });
    spec.compose(live.server, ctx);
    await live.server.connect(live.transport);
    return live;
  }

  // The GET stream is the session's liveness signal.
  function watchStream(live: LiveSession, res: ServerResponse): void {
    live.streams++;
    if (live.detachTimer) {
      clearTimeout(live.detachTimer);
      live.detachTimer = null;
    }
    res.once("close", () => {
      live.streams--;
      if (live.closed || live.streams > 0) return;
      live.detachTimer = setTimeout(() => {
        if (live.streams === 0) void closeSession(live, "event stream lost");
      }, detachGraceMs);
    });
  }

  async function sweepStale(): Promise<void> {
    const cutoff = now() - STALE_SESSION_MS;
    await Promise.all(
      [...sessions.values()]
        .filter((l) => l.streams === 0 && l.lastSeenMs < cutoff)
        .map((l) => closeSession(l, "stale: no event stream and no traffic")),
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized: bad or missing hub token" });
    const url = new URL(req.url ?? "/", `http://${HUB_HOST}`);
    if (url.pathname === HEALTH_PATH) return json(res, 200, health());
    if (url.pathname === SHUTDOWN_PATH && req.method === "POST") {
      json(res, 202, { ok: true });
      (opts.onShutdownRequest ?? (() => void stop()))();
      return;
    }
    if (url.pathname !== MCP_PATH) return json(res, 404, { error: "not found" });
    if (!ready) return json(res, 503, { error: "hub is starting; retry shortly" });

    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const live = sessions.get(sid);
      if (!live) return json(res, 404, { error: "unknown or expired session" });
      live.lastSeenMs = now();
      if (req.method === "GET") watchStream(live, res);
      return live.transport.handleRequest(req, res);
    }
    if (req.method !== "POST") return json(res, 400, { error: "a session id is required" });
    if (sessions.size >= maxSessions) {
      // Sweep first: a leaked session must never lock out a real conversation.
      await sweepStale();
      if (sessions.size >= maxSessions) {
        return json(res, 503, {
          error: `hub is at its ${maxSessions}-session limit; close a conversation and retry`,
        });
      }
    }
    const live = await openSession();
    try {
      await live.transport.handleRequest(req, res);
    } catch (err) {
      // Not in `sessions` yet, so nothing else would close it.
      await closeSession(live, "opener failed");
      throw err;
    }
    if (!live.transport.sessionId) await closeSession(live, "opener was not an initialize");
  }

  const http: HttpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`[hub] request failed: ${text(err)}`);
      if (!res.headersSent) json(res, 500, { error: text(err) });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, HUB_HOST, () => {
      http.off("error", reject);
      resolve();
    });
  });
  boundPort = (http.address() as AddressInfo).port;

  const sweep = setInterval(() => void sweepStale(), SWEEP_MS);
  sweep.unref();
  scheduleIdleExit();

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(sweep);
    clearIdleTimer();
    await Promise.all([...sessions.values()].map((l) => closeSession(l, "hub shutting down")));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  return {
    port: boundPort,
    setReady: () => {
      ready = true;
    },
    sessions: () =>
      [...sessions.values()].map((l) => ({
        id: l.ctx.id,
        source: l.ctx.source,
        connectedAtMs: l.ctx.connectedAtMs,
        lastSeenMs: l.lastSeenMs,
        attached: l.streams > 0,
        drawings: drawingCount(l.ctx.drawn),
      })),
    health,
    stop,
  };
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
