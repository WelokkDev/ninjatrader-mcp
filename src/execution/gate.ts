import type { GateDenyReason, OrderIntent } from "./types.js";
import type { TradingConfig } from "./config.js";

export const RATE_WINDOW_MS = 60_000;

export interface GateState {
  /** unix-ms timestamps of gate-accepted submits; drives the rolling rate limit. */
  recentSubmitsMs: number[];
  nowMs: number;
}

export interface GateVerdict {
  allowed: boolean;
  reason?: GateDenyReason;
  detail?: string;
}

/** Pure fail-closed gate. Order is load-bearing: master switch, then allow-list, qty cap, rate limit. */
export function evaluateGate(
  intent: Pick<OrderIntent, "account" | "quantity">,
  config: TradingConfig,
  state: GateState,
): GateVerdict {
  if (!config.enabled) {
    return { allowed: false, reason: "disabled", detail: "trading is disabled (NT_TRADING_ENABLED=0)" };
  }
  if (!config.allowAccounts.includes(intent.account)) {
    const list = config.allowAccounts.join(", ") || "(empty)";
    return {
      allowed: false,
      reason: "account-not-allowed",
      detail: `account "${intent.account}" is not in the allow-list [${list}]`,
    };
  }
  if (intent.quantity > config.maxQty) {
    return {
      allowed: false,
      reason: "qty-exceeds-max",
      detail: `quantity ${intent.quantity} exceeds max ${config.maxQty}`,
    };
  }
  if (config.maxOrdersPerMin > 0) {
    let recent = 0;
    for (const t of state.recentSubmitsMs) {
      if (state.nowMs - t < RATE_WINDOW_MS) recent++;
    }
    if (recent >= config.maxOrdersPerMin) {
      return {
        allowed: false,
        reason: "rate-limited",
        detail: `${recent} orders in the last 60s ≥ limit ${config.maxOrdersPerMin}`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Risk-reducing ops (cancel / cancel-all / flatten): allow-list ONLY, by design —
 * ignores `enabled`/`maxQty`/rate so they keep working through a kill-switch.
 * Kept in sync with the C# keystone's independent allow-list-only check (policy locked 2026-07-23, TRADING.md).
 * place/oco/change stay behind evaluateGate — they can add risk or open a position.
 */
export function evaluateRiskReducingGate(
  account: string,
  config: TradingConfig,
): GateVerdict {
  if (!config.allowAccounts.includes(account)) {
    const list = config.allowAccounts.join(", ") || "(empty)";
    return {
      allowed: false,
      reason: "account-not-allowed",
      detail: `account "${account}" is not in the allow-list [${list}]`,
    };
  }
  return { allowed: true };
}
