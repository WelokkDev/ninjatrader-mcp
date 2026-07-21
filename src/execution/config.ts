import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Same file the bridge token lives in (src/bridge/auth.ts). We read it fresh on
// every call rather than caching, so NT_TRADING_ENABLED=0 in .env.local
// disables the write path live, without a server restart. process.env wins over
// the file, so a launch-env master switch overrides an on-disk one.
const ENV_FILE = path.join(__dirname, "..", "..", ".env.local");

const ENABLED_KEY = "NT_TRADING_ENABLED";
const ACCOUNTS_KEY = "NT_TRADING_ALLOW_ACCOUNTS";
const MAX_QTY_KEY = "NT_TRADING_MAX_QTY";
const MAX_RATE_KEY = "NT_TRADING_MAX_ORDERS_PER_MIN";

// Conservative default when the rate limit is unset/invalid. An explicit 0
// means "no rate limit" (operator opt-out); everything else fails closed low.
const DEFAULT_MAX_ORDERS_PER_MIN = 6;

export interface TradingConfig {
  /** Master runtime switch. Also gates whether the tool is registered at all. */
  enabled: boolean;
  /** Exact account names permitted. Empty = nothing may be traded. */
  allowAccounts: string[];
  /** Per-order contract cap. 0 = nothing may be traded. */
  maxQty: number;
  /** Orders dispatched to NT8 per rolling 60s. 0 = unlimited. */
  maxOrdersPerMin: number;
}

function readEnvFile(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return map;
  let content: string;
  try {
    content = readFileSync(ENV_FILE, "utf-8");
  } catch {
    return map;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseAccounts(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNonNegInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/**
 * Read the trading gate fresh. Fail-closed: a missing/garbled source yields a
 * disabled config with an empty allow-list and a zero qty cap, so the default
 * posture is "no orders." This is the TS-side gate (layer 1); the C# AddOn
 * enforces an independent, un-recompilable gate of its own (the keystone).
 */
export function loadTradingConfig(env: NodeJS.ProcessEnv = process.env): TradingConfig {
  const file = readEnvFile();
  const get = (key: string): string | undefined => env[key] ?? file.get(key);

  return {
    enabled: isTruthy(get(ENABLED_KEY)),
    allowAccounts: parseAccounts(get(ACCOUNTS_KEY)),
    maxQty: parseNonNegInt(get(MAX_QTY_KEY), 0),
    maxOrdersPerMin: parseNonNegInt(get(MAX_RATE_KEY), DEFAULT_MAX_ORDERS_PER_MIN),
  };
}

/**
 * Whether to register the place_order tool at startup. When disabled, the tool
 * is never added to the MCP surface — Claude has nothing to call regardless of
 * mode. Re-enabling requires a restart (deliberate); disabling can be done live
 * via the runtime check. That asymmetry is intentional.
 */
export function isTradingRegistrationEnabled(): boolean {
  return loadTradingConfig().enabled;
}
