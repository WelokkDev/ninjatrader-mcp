import { randomUUID } from "crypto";
import {
  isConnected as bridgeIsConnected,
  request as bridgeRequest,
  getAddonCaps as bridgeGetAddonCaps,
  BridgeRequestError,
} from "../bridge/index.js";
import type {
  OrderAckMessage,
  OcoAckMessage,
  CancelAckMessage,
  CancelAllAckMessage,
  FlattenAckMessage,
  ChangeAckMessage,
} from "../bridge/protocol.js";
import { getLiveFeedRuntime } from "../live/runtime.js";
import { evaluateGate, evaluateRiskReducingGate } from "./gate.js";
import { loadTradingConfig, type TradingConfig } from "./config.js";
import {
  orderAudit,
  type OrderAudit,
  type OrderDecision,
  type OrderOpDecision,
  type OrderOpKind,
} from "./audit.js";
import type {
  BlockReason,
  CancelAllIntent,
  CancelAllResult,
  CancelIntent,
  CancelResult,
  ChangeIntent,
  ChangeResult,
  FlattenIntent,
  FlattenResult,
  OcoIntent,
  OcoResult,
  OpFailure,
  OrderIntent,
  OrderResult,
} from "./types.js";

// NT8 caps an order Name at 50 chars; clientOrderId rides through as the Name.
const MAX_CLIENT_ORDER_ID_LEN = 50;
// OCO leg names are `<base>:S` / `<base>:T`; keep the derived names ≤50.
const MAX_OCO_BASE_LEN = MAX_CLIENT_ORDER_ID_LEN - 3;

interface DispatchOutcome {
  decision: "blocked" | "failed";
  error: string;
  /** True only when the request provably never reached NT8. */
  certainlyNot: boolean;
  blockedBy?: BlockReason;
  /** C# code for the audit's denyReason (definitive blocks only). */
  denyReason?: string;
  code?: string;
}

interface DispatchSpec {
  /** C# codes raised BEFORE the NT8 call — provably never dispatched. */
  definitiveCodes: ReadonlySet<string>;
  /** C# codes meaning the NT8 API call itself threw — ambiguous outcome. */
  ambiguousCodes: ReadonlySet<string>;
  guidance: string;
  special?: Readonly<Record<string, string>>;
}

// Rejections raised BEFORE Submit() — certainly-not-submitted. Kept in sync
// with HandlePlaceOrder/HandlePlaceOco in mcp-bridge.cs.
const PRE_SUBMIT_CODES = new Set<string>([
  "gate-disabled",
  "account-not-allowed",
  "qty-exceeds-max",
  "invalid-params",
  "account-not-found",
  "instrument-not-found",
  "create-order-failed",
]);

const SUBMIT_THREW_CODES = new Set<string>(["submit-failed"]);

// Management-op codes raised before the NT8 call. already-terminal carries the
// terminal state (Filled vs Cancelled) in the message text.
const CANCEL_DEFINITIVE_CODES = new Set<string>([
  "invalid-params",
  "account-not-allowed",
  "account-not-found",
  "order-not-found",
  "already-terminal",
]);
const CHANGE_DEFINITIVE_CODES = new Set<string>([
  "invalid-params",
  "gate-disabled",
  "account-not-allowed",
  "qty-exceeds-max",
  "account-not-found",
  "order-not-found",
  "already-terminal",
  // State read threw BEFORE Account.Change() — provably never reached NT8
  // (distinct from "change-failed", the Change() call itself throwing).
  "state-read-failed",
]);
const INSTRUMENT_OP_DEFINITIVE_CODES = new Set<string>([
  "invalid-params",
  "account-not-allowed",
  "account-not-found",
  "instrument-not-found",
]);

function placeSpec(clientOrderId: string): DispatchSpec {
  return {
    definitiveCodes: PRE_SUBMIT_CODES,
    ambiguousCodes: SUBMIT_THREW_CODES,
    guidance:
      `the order MAY have been submitted; check get_positions before ` +
      `retrying, and reuse clientOrderId "${clientOrderId}" if you do`,
  };
}

function ocoSpec(baseId: string): DispatchSpec {
  return {
    definitiveCodes: PRE_SUBMIT_CODES,
    ambiguousCodes: SUBMIT_THREW_CODES,
    guidance:
      `the OCO pair MAY have been submitted; check get_positions before ` +
      `retrying, and reuse clientOrderId "${baseId}" if you do`,
    special: {
      "oco-partial":
        "one OCO leg may be working WITHOUT its sibling — check get_positions " +
        "and cancel the stray leg before retrying",
    },
  };
}

/** Cancel/change/cancel-all/flatten are idempotent, so ambiguous guidance can
 *  say retrying is safe. */
function managementSpec(
  op: OrderOpKind,
  definitiveCodes: ReadonlySet<string>,
  threwCode: string,
): DispatchSpec {
  return {
    definitiveCodes,
    ambiguousCodes: new Set([threwCode]),
    guidance:
      `the ${op} MAY have been dispatched; check get_positions / the order ` +
      `event stream — retrying this ${op} is safe`,
  };
}

const CANCEL_SPEC = managementSpec("cancel", CANCEL_DEFINITIVE_CODES, "cancel-failed");
const CANCEL_ALL_SPEC = managementSpec("cancel-all", INSTRUMENT_OP_DEFINITIVE_CODES, "cancel-all-failed");
const FLATTEN_SPEC = managementSpec("flatten", INSTRUMENT_OP_DEFINITIVE_CODES, "flatten-failed");
const CHANGE_SPEC = managementSpec("change", CHANGE_DEFINITIVE_CODES, "change-failed");

/** Classify a dispatch failure by TYPE, never by sniffing the message string.
 *  `certainlyNot` is true ONLY when the request provably never reached NT8;
 *  everything else is ambiguous (fail-safe). */
function classifyDispatch(err: unknown, rawError: string, spec: DispatchSpec): DispatchOutcome {
  const withGuidance = `${rawError} — ${spec.guidance}`;

  if (err instanceof BridgeRequestError) {
    switch (err.kind) {
      case "not-connected":
      case "send-failed":
        // Provably never crossed the wire.
        return { decision: "failed", error: rawError, certainlyNot: true };
      case "timeout":
      case "disconnected":
        // On the wire, outcome unknown.
        return { decision: "failed", error: withGuidance, certainlyNot: false };
      case "remote-error": {
        const code = err.code;
        if (code && spec.definitiveCodes.has(code)) {
          // Definitive keystone block (audited as `blocked`).
          return {
            decision: "blocked",
            error: rawError,
            certainlyNot: true,
            blockedBy: "addon-blocked",
            denyReason: code,
            code,
          };
        }
        if (code && spec.special && Object.hasOwn(spec.special, code)) {
          return {
            decision: "failed",
            error: `${rawError} — ${spec.special[code]}`,
            certainlyNot: false,
            code,
          };
        }
        if (code && spec.ambiguousCodes.has(code)) {
          // NT8 API call threw — may have partially landed.
          return { decision: "failed", error: withGuidance, certainlyNot: false, code };
        }
        // in-flight / codeless (old AddOn, deploy skew) / unknown: ambiguous, no
        // augmentation.
        return {
          decision: "failed",
          error: rawError,
          certainlyNot: false,
          ...(code ? { code } : {}),
        };
      }
    }
  }

  // Untyped/legacy error: fail safe (ambiguous), preserving timeout guidance.
  const timedOut = /timed out/i.test(rawError);
  return {
    decision: "failed",
    error: timedOut ? withGuidance : rawError,
    certainlyNot: false,
  };
}

/** "limitPrice rounded to tick: 23412.37 → 23412.25" when an ack's effective
 *  prices differ from the requested ones; undefined when nothing changed. */
function roundingNote(
  requested: { limitPrice?: number; stopPrice?: number },
  effective: { limitPrice?: number; stopPrice?: number },
): string | undefined {
  const parts: string[] = [];
  if (
    requested.limitPrice !== undefined &&
    effective.limitPrice !== undefined &&
    effective.limitPrice !== requested.limitPrice
  ) {
    parts.push(`limitPrice rounded to tick: ${requested.limitPrice} → ${effective.limitPrice}`);
  }
  if (
    requested.stopPrice !== undefined &&
    effective.stopPrice !== undefined &&
    effective.stopPrice !== requested.stopPrice
  ) {
    parts.push(`stopPrice rounded to tick: ${requested.stopPrice} → ${effective.stopPrice}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// A timeout here does NOT mean the op failed — it may have been dispatched; the
// result marks that ambiguity.
const WRITE_REQUEST_TIMEOUT_MS = 10_000;

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
  /** Best-effort: a failure downgrades to a warning, does not block the order.
   *  Must be idempotent/cheap. */
  ensurePositionFeed: () => Promise<EnsureFeedResult>;
  /** Write ops the AddOn declared in its hello `caps`. null = pre-caps AddOn
   *  (treated as ["place_order"]) or disconnected — lets ops fail fast with a
   *  recompile message instead of a 10s ambiguous timeout during deploy skew. */
  getAddonCaps: () => string[] | null;
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
  // The wire schema's max(50) is not runtime-enforced outbound; enforce it here
  // (the single seam every caller, incl. a future zod-bypassing Python one,
  // passes through). NT8 rejects an over-long order Name.
  if (
    intent.clientOrderId !== undefined &&
    (intent.clientOrderId.length < 1 || intent.clientOrderId.length > MAX_CLIENT_ORDER_ID_LEN)
  ) {
    return `clientOrderId must be 1–${MAX_CLIENT_ORDER_ID_LEN} characters (got ${intent.clientOrderId.length})`;
  }
  const needsLimit = intent.orderType === "Limit" || intent.orderType === "StopLimit";
  const needsStop = intent.orderType === "Stop" || intent.orderType === "StopLimit";

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

function finitePos(v: number | undefined): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function validateOcoIntent(intent: OcoIntent): string | null {
  if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
    return `quantity must be a positive integer (got ${intent.quantity})`;
  }
  if (
    intent.clientOrderId !== undefined &&
    (intent.clientOrderId.length < 1 || intent.clientOrderId.length > MAX_OCO_BASE_LEN)
  ) {
    return (
      `OCO base clientOrderId must be 1–${MAX_OCO_BASE_LEN} characters ` +
      `(leg names append ":S"/":T"; got ${intent.clientOrderId.length})`
    );
  }
  // Deliberately NOT validated: stop/limit side of market — NT8/broker owns that.
  if (!finitePos(intent.stopPrice)) {
    return "place_oco requires a positive stopPrice";
  }
  if (!finitePos(intent.limitPrice)) {
    return "place_oco requires a positive limitPrice";
  }
  return null;
}

function validateClientOrderIdRef(id: string): string | null {
  if (id.length < 1 || id.length > MAX_CLIENT_ORDER_ID_LEN) {
    return `clientOrderId must be 1–${MAX_CLIENT_ORDER_ID_LEN} characters (got ${id.length})`;
  }
  return null;
}

export function validateCancelIntent(intent: CancelIntent): string | null {
  if (!intent.account) return "account is required";
  return validateClientOrderIdRef(intent.clientOrderId ?? "");
}

export function validateInstrumentOpIntent(intent: { account: string; symbol: string }): string | null {
  if (!intent.account) return "account is required";
  if (!intent.symbol) return "symbol is required";
  return null;
}

export function validateChangeIntent(intent: ChangeIntent): string | null {
  if (!intent.account) return "account is required";
  const idError = validateClientOrderIdRef(intent.clientOrderId ?? "");
  if (idError) return idError;
  if (
    intent.quantity === undefined &&
    intent.limitPrice === undefined &&
    intent.stopPrice === undefined
  ) {
    return "change requires at least one of quantity, limitPrice, stopPrice";
  }
  if (intent.quantity !== undefined && (!Number.isInteger(intent.quantity) || intent.quantity <= 0)) {
    return `quantity must be a positive integer (got ${intent.quantity})`;
  }
  if (intent.limitPrice !== undefined && !finitePos(intent.limitPrice)) {
    return "limitPrice must be positive and finite";
  }
  if (intent.stopPrice !== undefined && !finitePos(intent.stopPrice)) {
    return "stopPrice must be positive and finite";
  }
  return null;
}

/**
 * The one gateway for the write path (MCP tools, future Python algo, in-process
 * TS walker all call these methods). All policy — validation, gates, rate
 * limiting, capability detection, fill-feed subscribe, audit trail — lives here
 * once. Bridge/positions deps are injected so it is unit-testable without NT8.
 *
 * Every method follows submit()'s shape: validate → gate → connected →
 * capability check → [rate slot] → dispatch → classify → audit.
 */
export class ExecutionService {
  private readonly deps: ExecutionServiceDeps;
  // Timestamps (unix-ms) of dispatched orders, for the rolling rate limit.
  // Risk-reducing ops never claim a slot — a rate-limited agent must still be
  // able to cancel/flatten.
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
      ocoGroup?: string | null;
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
        ocoGroup: extra.ocoGroup ?? null,
      });
    } catch (err) {
      // Never let an audit-write failure sink a real order decision.
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[execution] audit write failed: ${m}`);
    }
  }

  private auditOp(
    op: OrderOpKind,
    intent: { source: string; account: string; reason?: string },
    fields: {
      symbol?: string | null;
      clientOrderId?: string | null;
      quantity?: number | null;
      limitPrice?: number | null;
      stopPrice?: number | null;
    },
    decision: OrderOpDecision,
    extra: { denyReason?: string | null; state?: string | null; error?: string | null } = {},
  ): void {
    try {
      this.deps.audit.recordOp({
        ts: this.nowUnix(),
        op,
        source: intent.source,
        account: intent.account,
        symbol: fields.symbol ?? null,
        clientOrderId: fields.clientOrderId ?? null,
        quantity: fields.quantity ?? null,
        limitPrice: fields.limitPrice ?? null,
        stopPrice: fields.stopPrice ?? null,
        decision,
        denyReason: extra.denyReason ?? null,
        state: extra.state ?? null,
        error: extra.error ?? null,
        reason: intent.reason ?? null,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[execution] order_ops audit write failed: ${m}`);
    }
  }

  /** Best-effort — never blocks; a failure comes back as a warning string. */
  private async feedWarning(): Promise<string | undefined> {
    try {
      const feed = await this.deps.ensurePositionFeed();
      if (!feed.ok) {
        return (
          `position feed not active (${feed.error ?? "unknown"}) — fills and rejections ` +
          `will not stream live; poll get_positions to confirm the outcome`
        );
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return `position feed subscribe threw (${m}) — poll get_positions to confirm the outcome`;
    }
    return undefined;
  }

  /** null when the AddOn supports `op`; else a fast-fail (certainly-not-
   *  dispatched) error naming the fix. Caps absent = pre-caps AddOn (place_order
   *  only). */
  private capsError(op: string): string | null {
    const caps = this.deps.getAddonCaps() ?? ["place_order"];
    if (caps.includes(op)) return null;
    return (
      `the connected AddOn does not support ${op} — recompile ` +
      `ninja-addon/addons/mcp-bridge.cs in the NinjaScript Editor (F5) and reconnect`
    );
  }

  async submit(intent: OrderIntent): Promise<OrderResult> {
    const clientOrderId = intent.clientOrderId ?? this.newClientOrderId();

    const invalid = validateIntent(intent);
    if (invalid) {
      this.audit(intent, clientOrderId, "blocked", { denyReason: "validation", error: invalid });
      return { ok: false, clientOrderId, error: invalid, blockedBy: "validation", certainlyNotSubmitted: true };
    }

    // Fresh read so a live toggle applies to this order.
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

    const unsupported = this.capsError("place_order");
    if (unsupported) {
      this.audit(intent, clientOrderId, "failed", { error: unsupported });
      return { ok: false, clientOrderId, error: unsupported, blockedBy: "addon-unsupported", certainlyNotSubmitted: true };
    }

    // Claim the rate slot synchronously, before any await — else concurrent
    // submits all clear the gate during the feed await and overshoot
    // maxOrdersPerMin by the in-flight count.
    this.recentSubmitsMs.push(nowMs);
    this.pruneRate(nowMs);

    const warning = await this.feedWarning();

    // Only wire fields cross the bridge — never source/reason.
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
        WRITE_REQUEST_TIMEOUT_MS,
      )) as OrderAckMessage;

      const orderId = ack.orderId ?? null;
      const note = roundingNote(intent, ack);
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
        ...(note ? { note } : {}),
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err);
      const outcome = classifyDispatch(err, rawError, placeSpec(clientOrderId));
      this.audit(intent, clientOrderId, outcome.decision, {
        error: rawError,
        ...(outcome.denyReason ? { denyReason: outcome.denyReason } : {}),
      });
      return {
        ok: false,
        clientOrderId,
        error: outcome.error,
        ...(outcome.blockedBy ? { blockedBy: outcome.blockedBy } : {}),
        certainlyNotSubmitted: outcome.certainlyNot,
      };
    }
  }

  /** Protective stop + profit target as one atomic OCO pair. Full risk-adding
   *  gate (a triggered exit on a flat account OPENS a position); claims TWO rate
   *  slots; audits one order_submissions row per leg sharing oco_group. */
  async submitOco(intent: OcoIntent): Promise<OcoResult> {
    const base = intent.clientOrderId ?? this.newClientOrderId();
    const stopId = `${base}:S`;
    const targetId = `${base}:T`;
    const ocoId = base;

    // The two legs as audit-shaped intents.
    const stopLeg: OrderIntent = {
      account: intent.account,
      symbol: intent.symbol,
      action: intent.action,
      orderType: "Stop",
      quantity: intent.quantity,
      stopPrice: intent.stopPrice,
      tif: intent.tif,
      clientOrderId: stopId,
      source: intent.source,
      ...(intent.reason !== undefined ? { reason: intent.reason } : {}),
    };
    const targetLeg: OrderIntent = {
      account: intent.account,
      symbol: intent.symbol,
      action: intent.action,
      orderType: "Limit",
      quantity: intent.quantity,
      limitPrice: intent.limitPrice,
      tif: intent.tif,
      clientOrderId: targetId,
      source: intent.source,
      ...(intent.reason !== undefined ? { reason: intent.reason } : {}),
    };
    const auditLegs = (
      decision: OrderDecision,
      extra: { denyReason?: string; error?: string | null } = {},
    ): void => {
      this.audit(stopLeg, stopId, decision, { ...extra, ocoGroup: ocoId });
      this.audit(targetLeg, targetId, decision, { ...extra, ocoGroup: ocoId });
    };

    const invalid = validateOcoIntent(intent);
    if (invalid) {
      auditLegs("blocked", { denyReason: "validation", error: invalid });
      return { ok: false, clientOrderId: base, error: invalid, blockedBy: "validation", certainlyNotSubmitted: true };
    }

    const config = this.deps.loadConfig();
    const nowMs = this.nowMs();
    const verdict = evaluateGate({ account: intent.account, quantity: intent.quantity }, config, {
      recentSubmitsMs: this.recentSubmitsMs,
      nowMs,
    });
    if (!verdict.allowed) {
      const detail = verdict.detail ?? "blocked by trading gate";
      auditLegs("blocked", { denyReason: verdict.reason, error: detail });
      return { ok: false, clientOrderId: base, error: detail, blockedBy: verdict.reason, certainlyNotSubmitted: true };
    }

    if (!this.deps.isConnected()) {
      const error = "NinjaTrader bridge not connected";
      auditLegs("failed", { error });
      return { ok: false, clientOrderId: base, error, blockedBy: "not-connected", certainlyNotSubmitted: true };
    }

    const unsupported = this.capsError("place_oco");
    if (unsupported) {
      auditLegs("failed", { error: unsupported });
      return { ok: false, clientOrderId: base, error: unsupported, blockedBy: "addon-unsupported", certainlyNotSubmitted: true };
    }

    // Two orders — claim BOTH rate slots synchronously (see submit()).
    this.recentSubmitsMs.push(nowMs, nowMs);
    this.pruneRate(nowMs);

    const warning = await this.feedWarning();

    try {
      const ack = (await this.deps.request(
        "place_oco",
        {
          account: intent.account,
          symbol: intent.symbol,
          action: intent.action,
          quantity: intent.quantity,
          stopPrice: intent.stopPrice,
          limitPrice: intent.limitPrice,
          tif: intent.tif,
          ocoId,
          stopClientOrderId: stopId,
          targetClientOrderId: targetId,
        },
        WRITE_REQUEST_TIMEOUT_MS,
      )) as OcoAckMessage;

      const note = roundingNote(intent, ack);
      this.audit(stopLeg, stopId, "submitted", {
        contract: ack.contract,
        orderId: ack.stop.orderId ?? null,
        state: ack.stop.state,
        ocoGroup: ocoId,
      });
      this.audit(targetLeg, targetId, "submitted", {
        contract: ack.contract,
        orderId: ack.target.orderId ?? null,
        state: ack.target.state,
        ocoGroup: ocoId,
      });
      return {
        ok: true,
        ocoId: ack.ocoId,
        clientOrderId: base,
        contract: ack.contract,
        stop: {
          clientOrderId: ack.stop.clientOrderId,
          orderId: ack.stop.orderId ?? null,
          state: ack.stop.state,
        },
        target: {
          clientOrderId: ack.target.clientOrderId,
          orderId: ack.target.orderId ?? null,
          state: ack.target.state,
        },
        deduped: ack.deduped === true,
        ...(ack.stopPrice !== undefined ? { stopPrice: ack.stopPrice } : {}),
        ...(ack.limitPrice !== undefined ? { limitPrice: ack.limitPrice } : {}),
        ...(note ? { note } : {}),
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err);
      const outcome = classifyDispatch(err, rawError, ocoSpec(base));
      auditLegs(outcome.decision, {
        error: rawError,
        ...(outcome.denyReason ? { denyReason: outcome.denyReason } : {}),
      });
      return {
        ok: false,
        clientOrderId: base,
        error: outcome.error,
        ...(outcome.blockedBy ? { blockedBy: outcome.blockedBy } : {}),
        certainlyNotSubmitted: outcome.certainlyNot,
      };
    }
  }

  /** Cancel one working order. Risk-reducing gate: allow-list only — works with
   *  trading disabled, claims no rate slot. */
  async cancel(intent: CancelIntent): Promise<CancelResult> {
    const fields = { clientOrderId: intent.clientOrderId };

    const invalid = validateCancelIntent(intent);
    if (invalid) {
      this.auditOp("cancel", intent, fields, "blocked", { denyReason: "validation", error: invalid });
      return { ok: false, clientOrderId: intent.clientOrderId, error: invalid, blockedBy: "validation", certainlyNotDispatched: true };
    }

    const gated = this.riskReducingGateError("cancel", intent, fields);
    if (gated) return { ...gated, clientOrderId: intent.clientOrderId };

    const pre = this.preDispatchError("cancel", "cancel_order", intent, fields);
    if (pre) return { ...pre, clientOrderId: intent.clientOrderId };

    const warning = await this.feedWarning();

    try {
      const ack = (await this.deps.request(
        "cancel_order",
        { account: intent.account, clientOrderId: intent.clientOrderId },
        WRITE_REQUEST_TIMEOUT_MS,
      )) as CancelAckMessage;
      this.auditOp("cancel", intent, fields, "dispatched", { state: ack.state });
      return {
        ok: true,
        clientOrderId: ack.clientOrderId,
        orderId: ack.orderId ?? null,
        state: ack.state,
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      return {
        ...this.opFailure("cancel", CANCEL_SPEC, err, intent, fields),
        clientOrderId: intent.clientOrderId,
      };
    }
  }

  /** Cancel EVERY working order for the instrument — including manually placed
   *  ones. Risk-reducing gate; no rate slot. */
  async cancelAll(intent: CancelAllIntent): Promise<CancelAllResult> {
    const fields = { symbol: intent.symbol };

    const invalid = validateInstrumentOpIntent(intent);
    if (invalid) {
      this.auditOp("cancel-all", intent, fields, "blocked", { denyReason: "validation", error: invalid });
      return { ok: false, error: invalid, blockedBy: "validation", certainlyNotDispatched: true };
    }

    const gated = this.riskReducingGateError("cancel-all", intent, fields);
    if (gated) return gated;

    const pre = this.preDispatchError("cancel-all", "cancel_all", intent, fields);
    if (pre) return pre;

    const warning = await this.feedWarning();

    try {
      const ack = (await this.deps.request(
        "cancel_all",
        { account: intent.account, symbol: intent.symbol },
        WRITE_REQUEST_TIMEOUT_MS,
      )) as CancelAllAckMessage;
      this.auditOp("cancel-all", intent, fields, "dispatched", {});
      return {
        ok: true,
        contract: ack.contract,
        ...(ack.cancelledCount !== undefined ? { cancelledCount: ack.cancelledCount } : {}),
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      return this.opFailure("cancel-all", CANCEL_ALL_SPEC, err, intent, fields);
    }
  }

  /** Panic button: cancel working orders AND close the position at market.
   *  Risk-reducing gate; no rate slot. */
  async flatten(intent: FlattenIntent): Promise<FlattenResult> {
    const fields = { symbol: intent.symbol };

    const invalid = validateInstrumentOpIntent(intent);
    if (invalid) {
      this.auditOp("flatten", intent, fields, "blocked", { denyReason: "validation", error: invalid });
      return { ok: false, error: invalid, blockedBy: "validation", certainlyNotDispatched: true };
    }

    const gated = this.riskReducingGateError("flatten", intent, fields);
    if (gated) return gated;

    const pre = this.preDispatchError("flatten", "flatten", intent, fields);
    if (pre) return pre;

    const warning = await this.feedWarning();

    try {
      const ack = (await this.deps.request(
        "flatten",
        { account: intent.account, symbol: intent.symbol },
        WRITE_REQUEST_TIMEOUT_MS,
      )) as FlattenAckMessage;
      this.auditOp("flatten", intent, fields, "dispatched", {});
      return {
        ok: true,
        contract: ack.contract,
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      return this.opFailure("flatten", FLATTEN_SPEC, err, intent, fields);
    }
  }

  /** In-place amend of a working order (price/qty). FULL gate — a raised qty or
   *  widened stop adds risk; the TS qty check applies only when quantity is
   *  provided (the C# keystone re-checks against effective qty). Claims one rate
   *  slot. */
  async change(intent: ChangeIntent): Promise<ChangeResult> {
    const fields = {
      clientOrderId: intent.clientOrderId,
      quantity: intent.quantity ?? null,
      limitPrice: intent.limitPrice ?? null,
      stopPrice: intent.stopPrice ?? null,
    };

    const invalid = validateChangeIntent(intent);
    if (invalid) {
      this.auditOp("change", intent, fields, "blocked", { denyReason: "validation", error: invalid });
      return { ok: false, clientOrderId: intent.clientOrderId, error: invalid, blockedBy: "validation", certainlyNotDispatched: true };
    }

    const config = this.deps.loadConfig();
    const nowMs = this.nowMs();
    // quantity 0 when absent: exceeds no cap, so the qty check only bites when
    // the caller is raising it. Everything else applies in full.
    const verdict = evaluateGate({ account: intent.account, quantity: intent.quantity ?? 0 }, config, {
      recentSubmitsMs: this.recentSubmitsMs,
      nowMs,
    });
    if (!verdict.allowed) {
      const detail = verdict.detail ?? "blocked by trading gate";
      this.auditOp("change", intent, fields, "blocked", { denyReason: verdict.reason, error: detail });
      return { ok: false, clientOrderId: intent.clientOrderId, error: detail, blockedBy: verdict.reason, certainlyNotDispatched: true };
    }

    const pre = this.preDispatchError("change", "change_order", intent, fields);
    if (pre) return { ...pre, clientOrderId: intent.clientOrderId };

    // Claim the rate slot synchronously, before any await (see submit()).
    this.recentSubmitsMs.push(nowMs);
    this.pruneRate(nowMs);

    const warning = await this.feedWarning();

    try {
      const ack = (await this.deps.request(
        "change_order",
        {
          account: intent.account,
          clientOrderId: intent.clientOrderId,
          ...(intent.quantity !== undefined ? { quantity: intent.quantity } : {}),
          ...(intent.limitPrice !== undefined ? { limitPrice: intent.limitPrice } : {}),
          ...(intent.stopPrice !== undefined ? { stopPrice: intent.stopPrice } : {}),
        },
        WRITE_REQUEST_TIMEOUT_MS,
      )) as ChangeAckMessage;
      const note = roundingNote(intent, ack);
      this.auditOp("change", intent, fields, "dispatched", { state: ack.state });
      return {
        ok: true,
        clientOrderId: ack.clientOrderId,
        orderId: ack.orderId ?? null,
        state: ack.state,
        ...(ack.quantity !== undefined ? { quantity: ack.quantity } : {}),
        ...(ack.limitPrice !== undefined ? { limitPrice: ack.limitPrice } : {}),
        ...(ack.stopPrice !== undefined ? { stopPrice: ack.stopPrice } : {}),
        ...(note ? { note } : {}),
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      return {
        ...this.opFailure("change", CHANGE_SPEC, err, intent, fields),
        clientOrderId: intent.clientOrderId,
      };
    }
  }

  /** Shared risk-reducing gate step: audits and returns the failure, or null
   *  to proceed. */
  private riskReducingGateError(
    op: OrderOpKind,
    intent: { source: string; account: string; reason?: string },
    fields: Parameters<ExecutionService["auditOp"]>[2],
  ): OpFailure | null {
    const config = this.deps.loadConfig();
    const verdict = evaluateRiskReducingGate(intent.account, config);
    if (verdict.allowed) return null;
    const detail = verdict.detail ?? "blocked by trading gate";
    this.auditOp(op, intent, fields, "blocked", { denyReason: verdict.reason, error: detail });
    return { ok: false, error: detail, blockedBy: verdict.reason, certainlyNotDispatched: true };
  }

  /** Shared connected + capability step for the management ops. */
  private preDispatchError(
    op: OrderOpKind,
    messageType: string,
    intent: { source: string; account: string; reason?: string },
    fields: Parameters<ExecutionService["auditOp"]>[2],
  ): OpFailure | null {
    if (!this.deps.isConnected()) {
      const error = "NinjaTrader bridge not connected";
      this.auditOp(op, intent, fields, "failed", { error });
      return { ok: false, error, blockedBy: "not-connected", certainlyNotDispatched: true };
    }
    const unsupported = this.capsError(messageType);
    if (unsupported) {
      this.auditOp(op, intent, fields, "failed", { error: unsupported });
      return { ok: false, error: unsupported, blockedBy: "addon-unsupported", certainlyNotDispatched: true };
    }
    return null;
  }

  /** Shared classify + audit for a management-op dispatch failure. */
  private opFailure(
    op: OrderOpKind,
    spec: DispatchSpec,
    err: unknown,
    intent: { source: string; account: string; reason?: string },
    fields: Parameters<ExecutionService["auditOp"]>[2],
  ): OpFailure {
    const rawError = err instanceof Error ? err.message : String(err);
    const outcome = classifyDispatch(err, rawError, spec);
    this.auditOp(op, intent, fields, outcome.decision, {
      error: rawError,
      ...(outcome.denyReason ? { denyReason: outcome.denyReason } : {}),
    });
    return {
      ok: false,
      error: outcome.error,
      ...(outcome.blockedBy ? { blockedBy: outcome.blockedBy } : {}),
      ...(outcome.code ? { code: outcome.code } : {}),
      certainlyNotDispatched: outcome.certainlyNot,
    };
  }

  private pruneRate(nowMs: number): void {
    // Keep only the trailing 60s window.
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
    // bridgeRequest throws synchronously when disconnected; wrap to a rejection.
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
    getAddonCaps: bridgeGetAddonCaps,
  });
  return singleton;
}
