import type { ORDER_ACTIONS, ORDER_TYPES, ORDER_TIFS } from "../bridge/protocol.js";

export type OrderAction = (typeof ORDER_ACTIONS)[number];
export type OrderTypeName = (typeof ORDER_TYPES)[number];
export type TimeInForce = (typeof ORDER_TIFS)[number];

/**
 * A request to place one order. Transport-agnostic: the MCP tool, the future
 * Python algo (over local RPC), and an in-process TS walker all build one and
 * call the same ExecutionService.submit() — the single reuse seam.
 */
export interface OrderIntent {
  account: string;
  symbol: string;
  action: OrderAction;
  orderType: OrderTypeName;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  tif: TimeInForce;
  /**
   * Idempotency key. Generated when absent; a caller that may retry MUST reuse
   * the same value so the C# side dedupes the double-submit rather than firing
   * twice. Rides through as the NT8 order Name (≤50 chars).
   */
  clientOrderId?: string;
  /** Who initiated — "claude", "algo", etc. Persisted for the audit trail. */
  source: string;
  /** Free-text rationale, persisted for forensics. */
  reason?: string;
}

export type GateDenyReason =
  | "disabled"
  | "account-not-allowed"
  | "qty-exceeds-max"
  | "rate-limited";

/** Why a submit failed before or at the wire, for machine-readable handling.
 *  `addon-blocked` = the C# keystone gate refused it pre-Submit (certainly not
 *  submitted); the specific C# code is carried in the audit's denyReason. */
export type BlockReason =
  | GateDenyReason
  | "validation"
  | "not-connected"
  | "addon-blocked";

export type OrderResult =
  | {
      ok: true;
      clientOrderId: string;
      contract: string;
      /** NT8 order id, or null when NT8 hasn't assigned one yet at ack time. */
      orderId: string | null;
      /** Initial NT8 OrderState — an accept, NOT a fill. Watch get_positions /
       *  the order event stream for Filled or Rejected. */
      state: string;
      /** The C# side recognized the clientOrderId and did not re-submit. */
      deduped: boolean;
      /** Non-fatal note, e.g. the position feed could not be subscribed so
       *  fills/rejections won't stream live. */
      warning?: string;
    }
  | {
      ok: false;
      clientOrderId: string;
      error: string;
      /** Set when the failure was a policy/precondition decision. */
      blockedBy?: BlockReason;
      /**
       * True only when the order definitely never reached NT8. Absent means
       * ambiguous (e.g. an ack timeout) — don't blindly retry; reuse the same
       * clientOrderId if you do.
       */
      certainlyNotSubmitted?: boolean;
    };
