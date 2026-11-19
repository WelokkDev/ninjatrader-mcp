// No imports: `npm run connect-feed` loads this without the bridge.

export const CONNECT_FEED_DEFAULT_TIMEOUT_SEC = 60;
export const CONNECT_FEED_MIN_TIMEOUT_SEC = 5;
export const CONNECT_FEED_MAX_TIMEOUT_SEC = 180;
/** The AddOn retries a fresh hub with backoff capped at 30 s. */
export const ADDON_ATTACH_WAIT_MS = 35_000;
/** Covers the AddOn's green-must-hold window and the reply's trip back. */
export const CONNECT_FEED_REPLY_MARGIN_MS = 15_000;
const TRANSPORT_SLACK_MS = 10_000;

export const CONNECT_FEED_USAGE =
  'usage: npm run connect-feed [-- --connection "<NT8 connection name>"] [--timeout <seconds>]\n' +
  "Without --connection it uses NT_FEED_CONNECTION from .env.local.";

export interface ConnectFeedCliArgs {
  connection?: string;
  timeoutSec?: number;
}

export function parseConnectFeedArgs(argv: string[]): ConnectFeedCliArgs | { error: string } {
  const out: ConnectFeedCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { error: CONNECT_FEED_USAGE };
    const value = argv[i + 1];
    if (flag !== "--connection" && flag !== "--timeout") {
      return { error: `unknown argument: ${flag}\n${CONNECT_FEED_USAGE}` };
    }
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value\n${CONNECT_FEED_USAGE}` };
    i++;
    if (flag === "--connection") {
      out.connection = value;
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < CONNECT_FEED_MIN_TIMEOUT_SEC || n > CONNECT_FEED_MAX_TIMEOUT_SEC) {
        return {
          error: `--timeout must be a whole number of seconds from ${CONNECT_FEED_MIN_TIMEOUT_SEC} to ${CONNECT_FEED_MAX_TIMEOUT_SEC}, got ${value}`,
        };
      }
      out.timeoutSec = n;
    }
  }
  return out;
}

export function connectFeedCallTimeoutMs(timeoutSec: number = CONNECT_FEED_DEFAULT_TIMEOUT_SEC): number {
  return timeoutSec * 1000 + ADDON_ATTACH_WAIT_MS + CONNECT_FEED_REPLY_MARGIN_MS + TRANSPORT_SLACK_MS;
}

/** 0 connected, 1 the tool reported a failure, 2 the call never reached the tool. */
export function connectFeedExitCode(result: Record<string, unknown>): 0 | 1 | 2 {
  if (!result.isError) return 0;
  // Tool failures are JSON with `error`; SDK errors (unknown tool, bad arguments) are plain text.
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = (first as { type?: unknown; text?: unknown } | undefined)?.text;
  if ((first as { type?: unknown } | undefined)?.type !== "text" || typeof text !== "string") return 2;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof (parsed as { error?: unknown } | null)?.error === "string" ? 1 : 2;
  } catch {
    return 2;
  }
}
