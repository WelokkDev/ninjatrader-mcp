import { randomUUID } from "crypto";
import {
  isConnected as bridgeIsConnected,
  request as bridgeRequest,
} from "../bridge/index.js";
import type { OrderAckMessage } from "../bridge/protocol.js";
import { getLiveFeedRuntime } from "../live/runtime.js";
import { evaluateGate } from "./gate.js";
import { loadTradingConfig, type TradingConfig } from "./config.js";
import { orderAudit, type OrderAudit, type OrderDecision } from "./audit.js";
import type { OrderIntent, OrderResult } from "./types.js";

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
    const verdict = evaluateGate(intent, config, {
      recentSubmitsMs: this.recentSubmitsMs,
      nowMs: this.nowMs(),
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

    // Claim a rate slot — this order is about to hit NT8.
    const nowMs = this.nowMs();
    this.recentSubmitsMs.push(nowMs);
    this.pruneRate(nowMs);

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
      const error = err instanceof Error ? err.message : String(err);
      // A timeout is ambiguous — the order may have reached NT8. A send failure
      // means it definitely did not.
      const timedOut = /timed out/i.test(error);
      const sendFailed = /failed to send|not connected|disconnected/i.test(error);
      this.audit(intent, clientOrderId, "failed", { error });
      return {
        ok: false,
        clientOrderId,
        error: timedOut
          ? `${error} — the order MAY have been submitted; check get_positions before retrying, and reuse clientOrderId "${clientOrderId}" if you do`
          : error,
        certainlyNotSubmitted: sendFailed && !timedOut,
      };
    }
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
