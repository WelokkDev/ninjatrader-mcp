import type { ORDER_ACTIONS, ORDER_TYPES, ORDER_TIFS } from "../bridge/protocol.js";

export type OrderAction = (typeof ORDER_ACTIONS)[number];
export type OrderTypeName = (typeof ORDER_TYPES)[number];
export type TimeInForce = (typeof ORDER_TIFS)[number];

/** One order request. Transport-agnostic — all callers build one and call the
 *  same ExecutionService.submit(): the single reuse seam. */
export interface OrderIntent {
  account: string;
  symbol: string;
  action: OrderAction;
  orderType: OrderTypeName;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  tif: TimeInForce;
  /** Idempotency key; a retrying caller MUST reuse it so C# dedupes rather than
   *  firing twice. Rides through as the NT8 order Name (≤50 chars). */
  clientOrderId?: string;
  source: string;
  reason?: string;
}

/** OCO exit pair: protective stop (StopMarket) + profit target (Limit) sharing
 *  action/quantity/tif, submitted atomically so NT8 cancels the sibling on
 *  completion. A triggered exit on a flat account OPENS a position, so this
 *  rides the full risk-adding gate. */
export interface OcoIntent {
  account: string;
  symbol: string;
  /** Shared by both legs — Sell to exit a long, Buy to exit a short. */
  action: OrderAction;
  quantity: number;
  stopPrice: number;
  limitPrice: number;
  tif: TimeInForce;
  /** Base idempotency key (≤47 chars); leg keys derive as `<base>:S`/`<base>:T`
   *  and ride through as NT8 order Names. Reuse the echoed value to retry. */
  clientOrderId?: string;
  source: string;
  reason?: string;
}

/** Cancel one working order, addressed by its clientOrderId (= NT8 Name). */
export interface CancelIntent {
  account: string;
  clientOrderId: string;
  source: string;
  reason?: string;
}

/** Cancel EVERY working order for the instrument — including manual ones. */
export interface CancelAllIntent {
  account: string;
  symbol: string;
  source: string;
  reason?: string;
}

/** Cancel working orders AND close the position at market for the instrument. */
export interface FlattenIntent {
  account: string;
  symbol: string;
  source: string;
  reason?: string;
}

/** In-place amend of a working order; requires ≥1 of quantity/limitPrice/
 *  stopPrice. Unspecified fields keep their current values C#-side. */
export interface ChangeIntent {
  account: string;
  clientOrderId: string;
  quantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  source: string;
  reason?: string;
}

export type GateDenyReason =
  | "disabled"
  | "account-not-allowed"
  | "qty-exceeds-max"
  | "rate-limited";

/** `addon-blocked` = C# keystone gate refused pre-Submit (certainly not
 *  submitted); code carried in the audit's denyReason. `addon-unsupported` =
 *  AddOn hello caps lack this op — recompile mcp-bridge.cs (deploy skew),
 *  certainly not dispatched. */
export type BlockReason =
  | GateDenyReason
  | "validation"
  | "not-connected"
  | "addon-blocked"
  | "addon-unsupported";

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
      deduped: boolean;
      /** Set when the ack's effective prices differ from requested (tick
       *  rounding). */
      note?: string;
      warning?: string;
    }
  | {
      ok: false;
      clientOrderId: string;
      error: string;
      blockedBy?: BlockReason;
      /** True only when the order definitely never reached NT8. Absent =
       *  ambiguous (e.g. ack timeout) — don't blindly retry; reuse the same
       *  clientOrderId if you do. */
      certainlyNotSubmitted?: boolean;
    };

export interface OcoLegResult {
  clientOrderId: string;
  orderId: string | null;
  /** Initial NT8 OrderState — an accept, NOT a fill. */
  state: string;
}

export type OcoResult =
  | {
      ok: true;
      /** The NT8 OCO link id (= the base clientOrderId). */
      ocoId: string;
      /** Base idempotency key — reuse to retry an ambiguous result. */
      clientOrderId: string;
      contract: string;
      stop: OcoLegResult;
      target: OcoLegResult;
      deduped: boolean;
      /** Effective tick-rounded prices when the AddOn echoes them. */
      stopPrice?: number;
      limitPrice?: number;
      note?: string;
      warning?: string;
    }
  | {
      ok: false;
      /** Base idempotency key — reuse on retry of an ambiguous failure. */
      clientOrderId: string;
      error: string;
      blockedBy?: BlockReason;
      certainlyNotSubmitted?: boolean;
    };

/** Shared failure shape for management ops. `code` is the C# classifier when
 *  present (e.g. "order-not-found", "already-terminal"). `certainlyNotDispatched`
 *  mirrors placement's flag; absent = ambiguous, but these ops are idempotent
 *  so retrying is safe. */
export interface OpFailure {
  ok: false;
  error: string;
  blockedBy?: BlockReason;
  code?: string;
  certainlyNotDispatched?: boolean;
}

export type CancelResult =
  | {
      ok: true;
      clientOrderId: string;
      orderId: string | null;
      /** Post-Cancel() state — the REQUEST was accepted; watch for "Cancelled"
       *  (or a fill that beat it). */
      state: string;
      warning?: string;
    }
  | (OpFailure & { clientOrderId: string });

export type CancelAllResult =
  | {
      ok: true;
      contract: string;
      /** Best-effort count of working orders seen just before the call. */
      cancelledCount?: number;
      warning?: string;
    }
  | OpFailure;

export type FlattenResult =
  | {
      ok: true;
      contract: string;
      warning?: string;
    }
  | OpFailure;

export type ChangeResult =
  | {
      ok: true;
      clientOrderId: string;
      orderId: string | null;
      /** Post-Change() state — the amend REQUEST was accepted, not yet
       *  confirmed. */
      state: string;
      /** Effective post-rounding values the change was staged with. */
      quantity?: number;
      limitPrice?: number;
      stopPrice?: number;
      note?: string;
      warning?: string;
    }
  | (OpFailure & { clientOrderId: string });
