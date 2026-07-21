import type { GateDenyReason, OrderIntent } from "./types.js";
import type { TradingConfig } from "./config.js";

export const RATE_WINDOW_MS = 60_000;

export interface GateState {
  /** unix-ms timestamps of orders already dispatched to NT8 (accepted by the
   *  gate), used for the rolling rate limit. */
  recentSubmitsMs: number[];
  nowMs: number;
}

export interface GateVerdict {
  allowed: boolean;
  reason?: GateDenyReason;
  detail?: string;
}

/**
 * The whole gate policy, as one pure function of (intent, config, state) so it
 * is exhaustively unit-testable and identical for every caller. Order matters:
 * the master switch is checked first, then account allow-list, then the qty
 * cap, then the rate limit — cheapest and most-absolute first.
 */
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
