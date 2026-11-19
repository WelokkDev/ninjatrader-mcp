import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BridgeRequestError,
  capsError,
  getAddonCaps as defaultGetAddonCaps,
  type AddonCaps,
  isConnected as defaultIsConnected,
  request as defaultRequest,
} from "../bridge/index.js";
import {
  isInboundType,
  type ConnectFeedResponseMessage,
  type InboundMessage,
} from "../bridge/protocol.js";
import { envSetting } from "../core/env-local.js";
import {
  ADDON_ATTACH_WAIT_MS,
  CONNECT_FEED_DEFAULT_TIMEOUT_SEC,
  CONNECT_FEED_MAX_TIMEOUT_SEC,
  CONNECT_FEED_MIN_TIMEOUT_SEC,
  CONNECT_FEED_REPLY_MARGIN_MS,
} from "./connect-feed-shared.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

export const CONNECTION_ENV = "NT_FEED_CONNECTION";
const ATTACH_POLL_MS = 500;
const REQUIRED_CAP = "connect_feed";

export interface ConnectFeedArgs {
  connection?: string;
  timeoutSec?: number;
}

export interface ConnectFeedDeps {
  isConnected: () => boolean;
  getAddonCaps: () => AddonCaps;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<InboundMessage>;
  defaultConnection: () => string | undefined;
  attachWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A script that just started the hub calls before the AddOn has found it and sent its hello.
async function addonAttached(deps: ConnectFeedDeps): Promise<boolean> {
  const limit = deps.attachWaitMs ?? ADDON_ATTACH_WAIT_MS;
  const sleep = deps.sleep ?? sleepMs;
  const ready = (): boolean => deps.isConnected() && deps.getAddonCaps() !== undefined;
  for (let waited = 0; !ready(); waited += ATTACH_POLL_MS) {
    if (waited >= limit) return false;
    await sleep(ATTACH_POLL_MS);
  }
  return true;
}

function failureText(res: ConnectFeedResponseMessage): string {
  if (!res.found) {
    const names = res.configured?.length ? res.configured.join(", ") : "none reported";
    return `NT8 has no connection named '${res.connection}' (its connections: ${names})`;
  }
  let text = res.message ?? `could not connect ${res.connection}`;
  if (res.ntError !== undefined) {
    text += ` — NT8 error ${res.ntError}${res.nativeError ? `: "${res.nativeError}"` : ""}`;
  }
  return text;
}

function view(res: ConnectFeedResponseMessage): Record<string, unknown> {
  const others = res.connections.filter(
    (c) => c.name.toLowerCase() !== res.connection.toLowerCase() && c.priceStatus === "Connected",
  );
  return {
    ok: res.ok,
    connection: res.connection,
    alreadyConnected: res.alreadyConnected,
    ...(res.waitedForNt8 ? { waitedForNt8: true } : {}),
    status: res.status,
    priceStatus: res.priceStatus,
    elapsedMs: res.elapsedMs,
    ...(res.ntError !== undefined ? { ntError: res.ntError } : {}),
    ...(res.nativeError ? { nativeError: res.nativeError } : {}),
    connections: res.connections,
    ...(res.ok && others.length > 0
      ? {
          warning:
            `${others.map((c) => c.name).join(", ")} also delivers market data. NT8 takes live data ` +
            `from one connection (the first connected, unless one is set as preferred), so bars may not come from ${res.connection}.`,
        }
      : {}),
  };
}

export function createConnectFeedHandler(deps: ConnectFeedDeps) {
  return async (args: ConnectFeedArgs): Promise<ToolResult> => {
    const connection = args.connection?.trim() || deps.defaultConnection();
    if (!connection) {
      return errorResult(
        `connect_feed needs a connection name as NT8's Connections menu shows it: pass connection, or set ${CONNECTION_ENV} in .env.local.`,
      );
    }
    if (!(await addonAttached(deps))) {
      const waited = Math.round((deps.attachWaitMs ?? ADDON_ATTACH_WAIT_MS) / 1000);
      return errorResult(
        `NinjaTrader's McpBridge AddOn did not attach within ${waited}s — is NT8 running with the AddOn compiled?`,
        { connection },
      );
    }
    const unsupported = capsError(REQUIRED_CAP, deps.getAddonCaps());
    if (unsupported !== null) return errorResult(unsupported, { connection });

    const timeoutMs = (args.timeoutSec ?? CONNECT_FEED_DEFAULT_TIMEOUT_SEC) * 1000;
    let res: InboundMessage;
    try {
      res = await deps.request(
        "connect_feed",
        { connection, timeoutMs },
        timeoutMs + CONNECT_FEED_REPLY_MARGIN_MS,
      );
    } catch (err) {
      if (err instanceof BridgeRequestError && err.wasSent && err.kind !== "remote-error") {
        return errorResult(
          `connect_feed got no answer (${err.kind}) — NT8 may still be connecting; call connect_feed again to see where it stands.`,
          { connection },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`connect_feed failed: ${msg}`, { connection });
    }
    if (!isInboundType(res, "connect_feed_response")) {
      return errorResult(`connect_feed failed: unexpected response type '${res.type}'`, { connection });
    }
    return res.ok ? jsonResult(view(res)) : errorResult(failureText(res), view(res));
  };
}

export function registerConnectFeed(server: McpServer): void {
  const handler = createConnectFeedHandler({
    isConnected: defaultIsConnected,
    getAddonCaps: defaultGetAddonCaps,
    request: defaultRequest,
    defaultConnection: () => envSetting(CONNECTION_ENV),
  });
  server.tool(
    "connect_feed",
    "Connect one of NinjaTrader 8's connections (as named in NT8's Connections menu) and wait until both halves are green: orders and market data. Does nothing if it already is. If NT8 is already reconnecting by itself, waits for NT8 instead of connecting over it. A failure returns NT8's own error. The result also lists every connection's state.",
    {
      connection: z
        .string()
        .min(1)
        .optional()
        .describe(`Defaults to ${CONNECTION_ENV} in .env.local.`),
      timeoutSec: z
        .number()
        .int()
        .min(CONNECT_FEED_MIN_TIMEOUT_SEC)
        .max(CONNECT_FEED_MAX_TIMEOUT_SEC)
        .optional()
        .describe(`How long to wait for green. Default ${CONNECT_FEED_DEFAULT_TIMEOUT_SEC}.`),
    },
    handler,
  );
}
