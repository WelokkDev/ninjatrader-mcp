import { randomUUID } from "crypto";
import {
  isConnected as bridgeIsConnected,
  request as bridgeRequest,
  BridgeRequestError,
} from "../bridge/index.js";
import type { OrderAckMessage } from "../bridge/protocol.js";
import { getLiveFeedRuntime } from "../live/runtime.js";
import { evaluateGate } from "./gate.js";
import { loadTradingConfig, type TradingConfig } from "./config.js";
import { orderAudit, type OrderAudit, type OrderDecision } from "./audit.js";
import type { BlockReason, OrderIntent, OrderResult } from "./types.js";

// NT8 caps an order Name at 50 chars; clientOrderId rides through as the Name.
const MAX_CLIENT_ORDER_ID_LEN = 50;

/** How a dispatch failure (post-gate, at/after the wire) is classified. */
interface DispatchOutcome {
  decision: OrderDecision;
  /** Error text for the caller — may be augmented with retry guidance. */
  error: string;
  /** True only when the order provably never reached NT8. */
  certainlyNotSubmitted: boolean;
  blockedBy?: BlockReason;
  denyReason?: string;
}

// C# `error` codes for rejections raised BEFORE Submit() — safe to treat as
// certainly-not-submitted. Kept in sync with HandlePlaceOrder in mcp-bridge.cs.
const PRE_SUBMIT_CODES = new Set<string>([
  "gate-disabled",
  "account-not-allowed",
  "qty-exceeds-max",
  "invalid-params",
  "account-not-found",
  "instrument-not-found",
  "create-order-failed",
]);

// A submit ack is fast (Submit() returns as soon as NT8 accepts the call), so a
// short ceiling is right. A timeout here does NOT mean the order was rejected —
// it may have been submitted; the result marks that ambiguity.
const PLACE_ORDER_TIMEOUT_MS = 10_000;

export interface EnsureFeedResult {
  ok: boolean;
  error?: string;
}

export interface ExecutionServiceDeps {
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  isConnected: () => boolean;
  loadConfig: () => TradingConfig;
  audit: OrderAudit;
  /** Make sure order/execution events will stream (so fills and async
   *  rejections are observable live). Best-effort: a failure downgrades to a
   *  warning, it does not block the order. Should be idempotent/cheap. */
  ensurePositionFeed: () => Promise<EnsureFeedResult>;
  nowMs?: () => number;
  nowUnix?: () => number;
  newClientOrderId?: () => string;
}

/** Cross-field shape validation shared by every caller. Returns an error
 *  string, or null when the intent is well-formed. */
export function validateIntent(intent: OrderIntent): string | null {
  if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
    return `quantity must be a positive integer (got ${intent.quantity})`;
  }
  // The wire schema's max(50) is never runtime-enforced on outbound messages,
  // so enforce it here — the single seam every caller (incl. a future Python
  // one that bypasses zod) passes through. NT8 rejects an over-long order Name.
  if (
    intent.clientOrderId !== undefined &&
    (intent.clientOrderId.length < 1 || intent.clientOrderId.length > MAX_CLIENT_ORDER_ID_LEN)
  ) {
    return `clientOrderId must be 1–${MAX_CLIENT_ORDER_ID_LEN} characters (got ${intent.clientOrderId.length})`;
  }
  const needsLimit = intent.orderType === "Limit" || intent.orderType === "StopLimit";
  const needsStop = intent.orderType === "Stop" || intent.orderType === "StopLimit";
  const finitePos = (v: number | undefined): boolean =>
    typeof v === "number" && Number.isFinite(v) && v > 0;

  if (needsLimit && !finitePos(intent.limitPrice)) {
    return `${intent.orderType} order requires a positive limitPrice`;
  }
  if (needsStop && !finitePos(intent.stopPrice)) {
    return `${intent.orderType} order requires a positive stopPrice`;
  }
  if (intent.limitPrice !== undefined && !Number.isFinite(intent.limitPrice)) {
    return "limitPrice must be finite";
  }
  if (intent.stopPrice !== undefined && !Number.isFinite(intent.stopPrice)) {
    return "stopPrice must be finite";
  }
  return null;
}

/**
 * The one gateway for placing orders. The MCP tool, the future Python algo (via
 * a local RPC that adapts to this same API), and an in-process TS walker all
 * call submit(). Everything that is policy — validation, the gate, rate
 * limiting, auto-subscribing the fill feed, and the audit trail — lives here,
 * once. The bridge/positions dependencies are injected so the whole thing is
 * unit-testable without NT8.
 */
export class ExecutionService {
  private readonly deps: ExecutionServiceDeps;
  // Timestamps (unix-ms) of orders actually dispatched to NT8, for the rolling
  // rate limit. Pruned lazily on each submit.
  private readonly recentSubmitsMs: number[] = [];

  constructor(deps: ExecutionServiceDeps) {
    this.deps = deps;
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private nowUnix(): number {
    return this.deps.nowUnix ? this.deps.nowUnix() : Math.floor(Date.now() / 1000);
  }

  private newClientOrderId(): string {
    return this.deps.newClientOrderId ? this.deps.newClientOrderId() : randomUUID();
  }

  private audit(
    intent: OrderIntent,
    clientOrderId: string,
    decision: OrderDecision,
    extra: {
      denyReason?: string;
      contract?: string | null;
      orderId?: string | null;
      state?: string | null;
      error?: string | null;
    } = {},
  ): void {
    try {
      this.deps.audit.record({
        ts: this.nowUnix(),
        source: intent.source,
        clientOrderId,
        account: intent.account,
        symbol: intent.symbol,
        action: intent.action,
        orderType: intent.orderType,
        quantity: intent.quantity,
        limitPrice: intent.limitPrice ?? null,
        stopPrice: intent.stopPrice ?? null,
        tif: intent.tif,
        decision,
        denyReason: extra.denyReason ?? null,
        contract: extra.contract ?? null,
        orderId: extra.orderId ?? null,
        state: extra.state ?? null,
        error: extra.error ?? null,
        reason: intent.reason ?? null,
      });
    } catch (err) {
      // Never let an audit-write failure sink a real order decision.
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[execution] audit write failed: ${m}`);
    }
  }

  async submit(intent: OrderIntent): Promise<OrderResult> {
    const clientOrderId = intent.clientOrderId ?? this.newClientOrderId();

    const invalid = validateIntent(intent);
    if (invalid) {
      this.audit(intent, clientOrderId, "blocked", { denyReason: "validation", error: invalid });
      return { ok: false, clientOrderId, error: invalid, blockedBy: "validation", certainlyNotSubmitted: true };
    }

    // Fresh read so a live toggle (or disable) applies to this order.
    const config = this.deps.loadConfig();
    const nowMs = this.nowMs();
    const verdict = evaluateGate(intent, config, {
      recentSubmitsMs: this.recentSubmitsMs,
      nowMs,
    });
    if (!verdict.allowed) {
      const detail = verdict.detail ?? "blocked by trading gate";
      this.audit(intent, clientOrderId, "blocked", { denyReason: verdict.reason, error: detail });
      return { ok: false, clientOrderId, error: detail, blockedBy: verdict.reason, certainlyNotSubmitted: true };
    }

    if (!this.deps.isConnected()) {
      const error = "NinjaTrader bridge not connected";
      this.audit(intent, clientOrderId, "failed", { error });
      return { ok: false, clientOrderId, error, blockedBy: "not-connected", certainlyNotSubmitted: true };
    }

    // Claim the rate slot synchronously, before any await — otherwise concurrent
    // submits can all clear the gate during the feed await below and overshoot
    // maxOrdersPerMin by the in-flight count.
    this.recentSubmitsMs.push(nowMs);
    this.pruneRate(nowMs);

    // Make fills / async rejections observable. Best-effort — never blocks.
    let warning: string | undefined;
    try {
      const feed = await this.deps.ensurePositionFeed();
      if (!feed.ok) {
        warning =
          `position feed not active (${feed.error ?? "unknown"}) — fills and rejections ` +
          `will not stream live; poll get_positions to confirm the outcome`;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      warning = `position feed subscribe threw (${m}) — poll get_positions to confirm the outcome`;
    }

    // Only the wire fields cross the bridge — never source/reason.
    try {
      const ack = (await this.deps.request(
        "place_order",
        {
          account: intent.account,
          symbol: intent.symbol,
          action: intent.action,
          orderType: intent.orderType,
          quantity: intent.quantity,
          ...(intent.limitPrice !== undefined ? { limitPrice: intent.limitPrice } : {}),
          ...(intent.stopPrice !== undefined ? { stopPrice: intent.stopPrice } : {}),
          tif: intent.tif,
          clientOrderId,
        },
        PLACE_ORDER_TIMEOUT_MS,
      )) as OrderAckMessage;

      const orderId = ack.orderId ?? null;
      this.audit(intent, clientOrderId, "submitted", {
        contract: ack.contract,
        orderId,
        state: ack.state,
      });
      return {
        ok: true,
        clientOrderId,
        contract: ack.contract,
        orderId,
        state: ack.state,
        deduped: ack.deduped === true,
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err);
      const outcome = this.classifyDispatchError(err, rawError, clientOrderId);
      this.audit(intent, clientOrderId, outcome.decision, {
        error: rawError,
        ...(outcome.denyReason ? { denyReason: outcome.denyReason } : {}),
      });
      return {
        ok: false,
        clientOrderId,
        error: outcome.error,
        ...(outcome.blockedBy ? { blockedBy: outcome.blockedBy } : {}),
        certainlyNotSubmitted: outcome.certainlyNotSubmitted,
      };
    }
  }

  /** Classify a dispatch failure by TYPE, never by sniffing the message string.
   *  `certainlyNotSubmitted` is true ONLY when the order provably never reached
   *  NT8; everything else is ambiguous (fail-safe). */
  private classifyDispatchError(
    err: unknown,
    rawError: string,
    clientOrderId: string,
  ): DispatchOutcome {
    const ambiguousGuidance =
      `${rawError} — the order MAY have been submitted; check get_positions before ` +
      `retrying, and reuse clientOrderId "${clientOrderId}" if you do`;

    if (err instanceof BridgeRequestError) {
      switch (err.kind) {
        case "not-connected":
        case "send-failed":
          // Provably never crossed the wire.
          return { decision: "failed", error: rawError, certainlyNotSubmitted: true };
        case "timeout":
        case "disconnected":
          // On the wire, outcome unknown — same treatment.
          return { decision: "failed", error: ambiguousGuidance, certainlyNotSubmitted: false };
        case "remote-error":
          return this.classifyRemoteError(err.code, rawError, ambiguousGuidance);
      }
    }

    // Untyped / legacy error (e.g. a non-bridge throw). Fail safe: ambiguous.
    // Preserve the timeout guidance when the message looks like one.
    const timedOut = /timed out/i.test(rawError);
    return {
      decision: "failed",
      error: timedOut ? ambiguousGuidance : rawError,
      certainlyNotSubmitted: false,
    };
  }

  /** A C# `error` envelope. A pre-Submit code ⇒ a definitive keystone block
   *  (audited as `blocked`); submit-failed / in-flight ⇒ ambiguous; a codeless
   *  error (old AddOn, deploy skew) keeps today's conservative ambiguous form. */
  private classifyRemoteError(
    code: string | undefined,
    rawError: string,
    ambiguousGuidance: string,
  ): DispatchOutcome {
    if (code && PRE_SUBMIT_CODES.has(code)) {
      return {
        decision: "blocked",
        error: rawError,
        certainlyNotSubmitted: true,
        blockedBy: "addon-blocked",
        denyReason: code,
      };
    }
    if (code === "submit-failed") {
      // Submit() threw — may have partially landed. Ambiguous.
      return { decision: "failed", error: ambiguousGuidance, certainlyNotSubmitted: false };
    }
    // in-flight: the C# message already says "do not resubmit; check shortly".
    // Codeless/unknown: today's conservative ambiguous handling. Neither augments.
    return { decision: "failed", error: rawError, certainlyNotSubmitted: false };
  }

  private pruneRate(nowMs: number): void {
    // Keep only the trailing window; bound memory regardless of volume.
    const cutoff = nowMs - 60_000;
    let i = 0;
    while (i < this.recentSubmitsMs.length && this.recentSubmitsMs[i] < cutoff) i++;
    if (i > 0) this.recentSubmitsMs.splice(0, i);
  }
}

let singleton: ExecutionService | null = null;

/** Production wiring: the one execution gateway for this process. */
export function getExecutionService(): ExecutionService {
  if (singleton) return singleton;
  singleton = new ExecutionService({
    // request throws synchronously when disconnected; wrap to a rejection.
    request: async (type, payload, timeoutMs) => bridgeRequest(type, payload, timeoutMs),
    isConnected: bridgeIsConnected,
    loadConfig: loadTradingConfig,
    audit: orderAudit,
    ensurePositionFeed: async () => {
      const rt = getLiveFeedRuntime();
      if (!rt) return { ok: false, error: "live feed runtime not started" };
      const s = rt.positions.status();
      if (s.desired && s.upstreamAcked) return { ok: true };
      const res = await rt.positions.subscribe();
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
  });
  return singleton;
}
