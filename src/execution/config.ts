import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shared with the bridge token (src/bridge/auth.ts). Read fresh every call (no
// cache) so NT_TRADING_ENABLED=0 disables the write path live. process.env wins
// over the file, so a launch-env master switch overrides an on-disk one.
const ENV_FILE = path.join(__dirname, "..", "..", ".env.local");

const ENABLED_KEY = "NT_TRADING_ENABLED";
const ACCOUNTS_KEY = "NT_TRADING_ALLOW_ACCOUNTS";
const MAX_QTY_KEY = "NT_TRADING_MAX_QTY";
const MAX_RATE_KEY = "NT_TRADING_MAX_ORDERS_PER_MIN";

// Fail-closed default for unset/invalid rate limit. Explicit 0 = no limit.
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
 * Fail-closed: missing/garbled source yields disabled config, empty allow-list,
 * zero qty cap ("no orders"). TS-side gate (layer 1); the C# AddOn enforces an
 * independent gate of its own.
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
 * Register risk-ADDING tools (place_order / place_oco / change_order) at
 * startup: enabled AND at least one allow-listed account. Re-enabling requires
 * a restart (deliberate); disabling can be done live via the runtime check.
 */
export function isTradingRegistrationEnabled(): boolean {
  const cfg = loadTradingConfig();
  return cfg.enabled && cfg.allowAccounts.length > 0;
}

/**
 * Register risk-REDUCING tools (cancel_order / cancel_all / flatten) at startup:
 * any allow-listed account, independent of `enabled` — a kill-switch restart
 * still leaves working orders manageable.
 */
export function isRiskReducingRegistrationEnabled(): boolean {
  return loadTradingConfig().allowAccounts.length > 0;
}
