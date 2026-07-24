import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { BridgeRequestError } from "../../bridge/connection.js";
import { createOrderAudit, type OrderAudit } from "../audit.js";
import {
  ExecutionService,
  validateIntent,
  validateChangeIntent,
  validateOcoIntent,
  type ExecutionServiceDeps,
} from "../service.js";
import type { TradingConfig } from "../config.js";
import type {
  CancelAllIntent,
  CancelIntent,
  ChangeIntent,
  FlattenIntent,
  OcoIntent,
  OrderIntent,
} from "../types.js";

const CONFIG: TradingConfig = {
  enabled: true,
  allowAccounts: ["Sim101"],
  maxQty: 2,
  maxOrdersPerMin: 0,
};

const NOW_MS = 1_789_000_000_000;
const NOW_UNIX = Math.floor(NOW_MS / 1000);

// Harness-default caps so op tests exercise the real path; caps tests override.
const ALL_CAPS = [
  "place_order",
  "place_oco",
  "cancel_order",
  "cancel_all",
  "flatten",
  "change_order",
];

function marketBuy(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    account: "Sim101",
    symbol: "MNQ",
    action: "Buy",
    orderType: "Market",
    quantity: 1,
    tif: "Day",
    source: "test",
    ...overrides,
  };
}

function ackFor(clientOrderId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    id: "x",
    type: "order_ack",
    clientOrderId,
    contract: "MNQ 09-26",
    state: "Submitted",
    ...extra,
  };
}

interface Harness {
  service: ExecutionService;
  request: ReturnType<typeof vi.fn>;
  audit: OrderAudit;
  ensureFeed: ReturnType<typeof vi.fn>;
}

function makeService(over: Partial<ExecutionServiceDeps> = {}): Harness {
  const db = new Database(":memory:");
  initializeSchema(db);
  const audit = createOrderAudit(db);
  const request = vi.fn(async (_t: string, p: Record<string, unknown>) =>
    ackFor(String(p.clientOrderId)),
  );
  const ensureFeed = vi.fn(async () => ({ ok: true }));
  const deps: ExecutionServiceDeps = {
    request: request as ExecutionServiceDeps["request"],
    isConnected: () => true,
    loadConfig: () => CONFIG,
    audit,
    ensurePositionFeed: ensureFeed,
    getAddonCaps: () => ALL_CAPS,
    nowMs: () => NOW_MS,
    nowUnix: () => NOW_UNIX,
    newClientOrderId: () => "coid-1",
    ...over,
  };
  // Hand back the EFFECTIVE request mock so overriding tests still inspect calls.
  return {
    service: new ExecutionService(deps),
    request: deps.request as ReturnType<typeof vi.fn>,
    audit,
    ensureFeed,
  };
}

describe("validateIntent", () => {
  it("passes a market order with no prices", () => {
    expect(validateIntent(marketBuy())).toBeNull();
  });
  it("requires limitPrice for a Limit", () => {
    expect(validateIntent(marketBuy({ orderType: "Limit" }))).toMatch(/limitPrice/);
  });
  it("requires stopPrice for a Stop", () => {
    expect(validateIntent(marketBuy({ orderType: "Stop" }))).toMatch(/stopPrice/);
  });
  it("requires both for a StopLimit", () => {
    expect(
      validateIntent(marketBuy({ orderType: "StopLimit", stopPrice: 100 })),
    ).toMatch(/limitPrice/);
  });
  it("rejects non-positive quantity", () => {
    expect(validateIntent(marketBuy({ quantity: 0 }))).toMatch(/quantity/);
  });
  it("rejects a clientOrderId longer than 50 chars", () => {
    expect(validateIntent(marketBuy({ clientOrderId: "x".repeat(51) }))).toMatch(/clientOrderId/);
  });
  it("accepts a 50-char clientOrderId", () => {
    expect(validateIntent(marketBuy({ clientOrderId: "x".repeat(50) }))).toBeNull();
  });
});

describe("ExecutionService.submit", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeService();
  });

  it("submits an in-policy order and audits it", async () => {
    const r = await h.service.submit(marketBuy());
    expect(r).toMatchObject({
      ok: true,
      clientOrderId: "coid-1",
      contract: "MNQ 09-26",
      state: "Submitted",
      deduped: false,
    });
    expect(h.request).toHaveBeenCalledOnce();
    const rows = h.audit.recent();
    expect(rows[0]).toMatchObject({ decision: "submitted", clientOrderId: "coid-1", source: "test" });
  });

  it("sends only wire fields on the bridge (never source/reason)", async () => {
    await h.service.submit(marketBuy({ reason: "because", source: "algo" }));
    const [, payload] = h.request.mock.calls[0];
    expect(payload).not.toHaveProperty("source");
    expect(payload).not.toHaveProperty("reason");
    expect(payload).toMatchObject({ account: "Sim101", clientOrderId: "coid-1" });
  });

  it("blocks a disabled gate without touching the bridge", async () => {
    h = makeService({ loadConfig: () => ({ ...CONFIG, enabled: false }) });
    const r = await h.service.submit(marketBuy());
    expect(r).toMatchObject({ ok: false, blockedBy: "disabled", certainlyNotSubmitted: true });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.audit.recent()[0]).toMatchObject({ decision: "blocked", denyReason: "disabled" });
  });

  it("blocks an off-allow-list account", async () => {
    const r = await h.service.submit(marketBuy({ account: "Apex-1" }));
    expect(r).toMatchObject({ ok: false, blockedBy: "account-not-allowed" });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("blocks over-cap quantity", async () => {
    const r = await h.service.submit(marketBuy({ quantity: 5 }));
    expect(r).toMatchObject({ ok: false, blockedBy: "qty-exceeds-max" });
  });

  it("blocks a malformed order (validation) before the gate", async () => {
    const r = await h.service.submit(marketBuy({ orderType: "Limit" }));
    expect(r).toMatchObject({ ok: false, blockedBy: "validation", certainlyNotSubmitted: true });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("fails closed when the bridge is disconnected", async () => {
    h = makeService({ isConnected: () => false });
    const r = await h.service.submit(marketBuy());
    expect(r).toMatchObject({ ok: false, blockedBy: "not-connected", certainlyNotSubmitted: true });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("enforces the rate limit across calls", async () => {
    h = makeService({ loadConfig: () => ({ ...CONFIG, maxOrdersPerMin: 1 }) });
    const r1 = await h.service.submit(marketBuy({ clientOrderId: "a" }));
    const r2 = await h.service.submit(marketBuy({ clientOrderId: "b" }));
    expect(r1.ok).toBe(true);
    expect(r2).toMatchObject({ ok: false, blockedBy: "rate-limited" });
  });

  it("marks an ack timeout as ambiguous (not certainlyNotSubmitted)", async () => {
    h = makeService({
      request: vi.fn(async () => {
        throw new Error("Request place_order (x) timed out after 10000ms");
      }) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.submit(marketBuy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).not.toBe(true);
      expect(r.error).toMatch(/MAY have been submitted/);
    }
    expect(h.audit.recent()[0]).toMatchObject({ decision: "failed" });
  });

  it("passes through a deduped ack from the C# side", async () => {
    h = makeService({
      request: vi.fn(async (_t, p: Record<string, unknown>) =>
        ackFor(String(p.clientOrderId), { deduped: true, orderId: "O-7" }),
      ) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.submit(marketBuy());
    expect(r).toMatchObject({ ok: true, deduped: true, orderId: "O-7" });
  });

  it("still submits but warns when the fill feed can't be subscribed", async () => {
    h = makeService({ ensurePositionFeed: vi.fn(async () => ({ ok: false, error: "no runtime" })) });
    const r = await h.service.submit(marketBuy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/position feed not active/);
  });

  it("generates a clientOrderId when the caller omits one", async () => {
    const r = await h.service.submit(marketBuy({ clientOrderId: undefined }));
    expect(r.clientOrderId).toBe("coid-1");
    const [, payload] = h.request.mock.calls[0];
    expect(payload).toMatchObject({ clientOrderId: "coid-1" });
  });

  // dispatch-failure classification: by typed error, never by string

  function throwing(err: unknown): Partial<ExecutionServiceDeps> {
    return {
      request: vi.fn(async () => {
        throw err;
      }) as ExecutionServiceDeps["request"],
    };
  }

  it("a disconnect WHILE WAITING is ambiguous, NOT certainlyNotSubmitted", async () => {
    // Regression: matching /disconnected/ reported certainlyNotSubmitted → retry → double order.
    h = makeService(
      throwing(
        new BridgeRequestError(
          "NinjaTrader disconnected while waiting for response",
          "disconnected",
          true,
        ),
      ),
    );
    const r = await h.service.submit(marketBuy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(false);
      expect(r.error).toMatch(/MAY have been submitted/);
    }
    expect(h.audit.recent()[0]).toMatchObject({ decision: "failed" });
  });

  it("a send failure IS certainlyNotSubmitted", async () => {
    h = makeService(
      throwing(
        new BridgeRequestError("failed to send request place_order (x): closed", "send-failed", false),
      ),
    );
    const r = await h.service.submit(marketBuy());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.certainlyNotSubmitted).toBe(true);
    expect(h.audit.recent()[0]).toMatchObject({ decision: "failed" });
  });

  it("a not-connected error (racing disconnect) IS certainlyNotSubmitted", async () => {
    h = makeService(throwing(new BridgeRequestError("bridge not connected", "not-connected", false)));
    const r = await h.service.submit(marketBuy());
    if (!r.ok) expect(r.certainlyNotSubmitted).toBe(true);
  });

  it("a typed ack timeout stays ambiguous", async () => {
    h = makeService(
      throwing(new BridgeRequestError("Request place_order (x) timed out after 10000ms", "timeout", true)),
    );
    const r = await h.service.submit(marketBuy());
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(false);
      expect(r.error).toMatch(/MAY have been submitted/);
    }
  });

  it("a coded AddOn gate block → blocked audit + certainlyNotSubmitted + addon-blocked", async () => {
    h = makeService(
      throwing(new BridgeRequestError("AddOn trading gate disabled", "remote-error", true, "gate-disabled")),
    );
    const r = await h.service.submit(marketBuy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(true);
      expect(r.blockedBy).toBe("addon-blocked");
    }
    expect(h.audit.recent()[0]).toMatchObject({ decision: "blocked", denyReason: "gate-disabled" });
  });

  it("a submit-failed code is ambiguous (Submit() threw — may have landed)", async () => {
    h = makeService(
      throwing(new BridgeRequestError("Submit failed: margin", "remote-error", true, "submit-failed")),
    );
    const r = await h.service.submit(marketBuy());
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(false);
      expect(r.error).toMatch(/MAY have been submitted/);
    }
    expect(h.audit.recent()[0]).toMatchObject({ decision: "failed" });
  });

  it("an in-flight code is ambiguous and keeps the do-not-resubmit guidance", async () => {
    h = makeService(
      throwing(
        new BridgeRequestError(
          "order with clientOrderId 'x' is currently in flight — do not resubmit; check again shortly",
          "remote-error",
          true,
          "in-flight",
        ),
      ),
    );
    const r = await h.service.submit(marketBuy());
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(false);
      expect(r.error).toMatch(/do not resubmit/);
      expect(r.error).not.toMatch(/MAY have been submitted/);
    }
  });

  it("a codeless AddOn error keeps today's conservative ambiguous handling (deploy skew)", async () => {
    h = makeService(
      throwing(new BridgeRequestError("account 'X' is not in the AddOn allow-list", "remote-error", true)),
    );
    const r = await h.service.submit(marketBuy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(false);
      expect(r.blockedBy).toBeUndefined();
    }
    expect(h.audit.recent()[0]).toMatchObject({ decision: "failed" });
  });

  it("passes a rounding note through when the ack's effective prices differ", async () => {
    h = makeService({
      request: vi.fn(async (_t, p: Record<string, unknown>) =>
        ackFor(String(p.clientOrderId), { limitPrice: 23412.25 }),
      ) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.submit(
      marketBuy({ orderType: "Limit", limitPrice: 23412.37 }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.note).toMatch(/limitPrice rounded to tick: 23412.37 → 23412.25/);
  });

  it("place_order still works against a pre-caps AddOn (caps=null)", async () => {
    h = makeService({ getAddonCaps: () => null });
    const r = await h.service.submit(marketBuy());
    expect(r.ok).toBe(true);
  });

  it("(B1) claims the rate slot before awaiting — concurrent submits can't both pass (limit 1)", async () => {
    // Feed subscribe held open so both submits are in flight; slot must be claimed pre-await.
    let releaseFeed: () => void = () => {};
    const feedGate = new Promise<void>((res) => {
      releaseFeed = res;
    });
    h = makeService({
      loadConfig: () => ({ ...CONFIG, maxOrdersPerMin: 1 }),
      ensurePositionFeed: vi.fn(async () => {
        await feedGate;
        return { ok: true };
      }),
    });
    const p1 = h.service.submit(marketBuy({ clientOrderId: "a" }));
    const p2 = h.service.submit(marketBuy({ clientOrderId: "b" }));
    releaseFeed();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    expect([r1, r2].filter((r) => !r.ok && r.blockedBy === "rate-limited")).toHaveLength(1);
    expect(h.request).toHaveBeenCalledOnce();
  });
});

// phase 2: OCO + management ops

function ocoExit(over: Partial<OcoIntent> = {}): OcoIntent {
  return {
    account: "Sim101",
    symbol: "MNQ",
    action: "Sell",
    quantity: 1,
    stopPrice: 100,
    limitPrice: 200,
    tif: "Gtc",
    source: "test",
    ...over,
  };
}

function ocoAckFor(p: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    id: "x",
    type: "oco_ack",
    ocoId: String(p.ocoId),
    contract: "MNQ 09-26",
    stop: { clientOrderId: String(p.stopClientOrderId), orderId: "O-S", state: "Submitted" },
    target: { clientOrderId: String(p.targetClientOrderId), orderId: "O-T", state: "Submitted" },
    ...extra,
  };
}

function withOcoAck(over: Partial<ExecutionServiceDeps> = {}): Harness {
  return makeService({
    request: vi.fn(async (_t: string, p: Record<string, unknown>) =>
      ocoAckFor(p),
    ) as ExecutionServiceDeps["request"],
    ...over,
  });
}

function remoteError(message: string, code?: string): Partial<ExecutionServiceDeps> {
  return {
    request: vi.fn(async () => {
      throw new BridgeRequestError(message, "remote-error", true, code);
    }) as ExecutionServiceDeps["request"],
  };
}

function timeoutError(op: string): Partial<ExecutionServiceDeps> {
  return {
    request: vi.fn(async () => {
      throw new BridgeRequestError(`Request ${op} (x) timed out after 10000ms`, "timeout", true);
    }) as ExecutionServiceDeps["request"],
  };
}

describe("ExecutionService.submitOco", () => {
  it("derives leg ids from the base, submits, and audits two rows sharing oco_group", async () => {
    const h = withOcoAck();
    const r = await h.service.submitOco(ocoExit());
    expect(r).toMatchObject({
      ok: true,
      ocoId: "coid-1",
      clientOrderId: "coid-1",
      contract: "MNQ 09-26",
      stop: { clientOrderId: "coid-1:S", orderId: "O-S", state: "Submitted" },
      target: { clientOrderId: "coid-1:T", orderId: "O-T", state: "Submitted" },
      deduped: false,
    });
    const [, payload] = h.request.mock.calls[0];
    expect(payload).toMatchObject({
      ocoId: "coid-1",
      stopClientOrderId: "coid-1:S",
      targetClientOrderId: "coid-1:T",
    });
    expect(payload).not.toHaveProperty("source");
    const rows = h.audit.recent();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.ocoGroup === "coid-1")).toBe(true);
    const types = rows.map((row) => row.orderType).sort();
    expect(types).toEqual(["Limit", "Stop"]);
    expect(rows.map((row) => row.clientOrderId).sort()).toEqual(["coid-1:S", "coid-1:T"]);
  });

  it("rejects a base clientOrderId longer than 47 chars (leg suffix room)", async () => {
    const h = withOcoAck();
    const r = await h.service.submitOco(ocoExit({ clientOrderId: "x".repeat(48) }));
    expect(r).toMatchObject({ ok: false, blockedBy: "validation", certainlyNotSubmitted: true });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("rides the FULL gate — blocked when trading is disabled", async () => {
    const h = withOcoAck({ loadConfig: () => ({ ...CONFIG, enabled: false }) });
    const r = await h.service.submitOco(ocoExit());
    expect(r).toMatchObject({ ok: false, blockedBy: "disabled", certainlyNotSubmitted: true });
    expect(h.audit.recent()).toHaveLength(2);
    expect(h.audit.recent().every((row) => row.decision === "blocked")).toBe(true);
  });

  it("claims TWO rate slots — limit 2 blocks the second pair", async () => {
    const h = withOcoAck({ loadConfig: () => ({ ...CONFIG, maxOrdersPerMin: 2 }) });
    const r1 = await h.service.submitOco(ocoExit({ clientOrderId: "a" }));
    const r2 = await h.service.submitOco(ocoExit({ clientOrderId: "b" }));
    expect(r1.ok).toBe(true);
    expect(r2).toMatchObject({ ok: false, blockedBy: "rate-limited" });
  });

  it("fails fast with a recompile message when the AddOn lacks place_oco", async () => {
    const h = withOcoAck({ getAddonCaps: () => ["place_order"] });
    const r = await h.service.submitOco(ocoExit());
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-unsupported", certainlyNotSubmitted: true });
    if (!r.ok) expect(r.error).toMatch(/recompile.*mcp-bridge\.cs/);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("notes tick rounding when the ack's effective prices differ", async () => {
    const h = makeService({
      request: vi.fn(async (_t: string, p: Record<string, unknown>) =>
        ocoAckFor(p, { stopPrice: 100.25 }),
      ) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.submitOco(ocoExit({ stopPrice: 100.37 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.note).toMatch(/stopPrice rounded to tick: 100.37 → 100.25/);
      expect(r.stopPrice).toBe(100.25);
    }
  });

  it("oco-partial is ambiguous with stray-leg guidance", async () => {
    const h = makeService(remoteError("stop leg acked without target", "oco-partial"));
    const r = await h.service.submitOco(ocoExit());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(false);
      expect(r.error).toMatch(/cancel the stray leg/);
    }
  });

  it("an in-flight pair is ambiguous WITHOUT stray-leg guidance (concurrent resubmit)", async () => {
    const h = makeService(
      remoteError("OCO pair 'coid-1' is currently in flight — do not resubmit; check again shortly", "in-flight"),
    );
    const r = await h.service.submitOco(ocoExit());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.certainlyNotSubmitted).toBe(false);
      expect(r.error).toMatch(/in flight/);
      expect(r.error).not.toMatch(/cancel the stray leg/);
    }
  });

  it("a keystone code (gate-disabled) is a definitive block for the pair", async () => {
    const h = makeService(remoteError("AddOn trading gate disabled", "gate-disabled"));
    const r = await h.service.submitOco(ocoExit());
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-blocked", certainlyNotSubmitted: true });
    expect(h.audit.recent().every((row) => row.decision === "blocked")).toBe(true);
  });
});

function cancelIntent(over: Partial<CancelIntent> = {}): CancelIntent {
  return { account: "Sim101", clientOrderId: "coid-9", source: "test", ...over };
}

function withCancelAck(over: Partial<ExecutionServiceDeps> = {}): Harness {
  return makeService({
    request: vi.fn(async (_t: string, p: Record<string, unknown>) => ({
      v: 1,
      id: "x",
      type: "cancel_ack",
      clientOrderId: String(p.clientOrderId),
      orderId: "O-9",
      state: "CancelSubmitted",
    })) as ExecutionServiceDeps["request"],
    ...over,
  });
}

describe("ExecutionService.cancel", () => {
  it("dispatches and audits to order_ops", async () => {
    const h = withCancelAck();
    const r = await h.service.cancel(cancelIntent({ reason: "resize" }));
    expect(r).toMatchObject({
      ok: true,
      clientOrderId: "coid-9",
      orderId: "O-9",
      state: "CancelSubmitted",
    });
    const [type, payload] = h.request.mock.calls[0];
    expect(type).toBe("cancel_order");
    expect(payload).toEqual({ account: "Sim101", clientOrderId: "coid-9" });
    const ops = h.audit.recentOps();
    expect(ops[0]).toMatchObject({
      op: "cancel",
      decision: "dispatched",
      account: "Sim101",
      clientOrderId: "coid-9",
      symbol: null,
      state: "CancelSubmitted",
      reason: "resize",
    });
  });

  it("works with trading DISABLED — risk-reducing gate is allow-list only", async () => {
    const h = withCancelAck({
      loadConfig: () => ({ ...CONFIG, enabled: false, maxQty: 0 }),
    });
    const r = await h.service.cancel(cancelIntent());
    expect(r.ok).toBe(true);
  });

  it("blocks an off-allow-list account", async () => {
    const h = withCancelAck();
    const r = await h.service.cancel(cancelIntent({ account: "Apex-1" }));
    expect(r).toMatchObject({ ok: false, blockedBy: "account-not-allowed", certainlyNotDispatched: true });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.audit.recentOps()[0]).toMatchObject({ op: "cancel", decision: "blocked" });
  });

  it("claims NO rate slot — cancels keep working after the window fills", async () => {
    // Limit 1: submit takes the only slot; cancel must still pass.
    const perTypeAck = vi.fn(async (t: string, p: Record<string, unknown>) =>
      t === "place_order"
        ? ackFor(String(p.clientOrderId))
        : {
            v: 1,
            id: "x",
            type: "cancel_ack",
            clientOrderId: String(p.clientOrderId),
            state: "CancelSubmitted",
          },
    );
    const h = makeService({
      loadConfig: () => ({ ...CONFIG, maxOrdersPerMin: 1 }),
      request: perTypeAck as ExecutionServiceDeps["request"],
    });
    expect((await h.service.submit(marketBuy())).ok).toBe(true);
    expect((await h.service.cancel(cancelIntent())).ok).toBe(true);
    // slot still occupied for risk-adding ops:
    const r3 = await h.service.submit(marketBuy({ clientOrderId: "c" }));
    expect(r3).toMatchObject({ ok: false, blockedBy: "rate-limited" });
  });

  it("order-not-found is a definitive block with the code surfaced", async () => {
    const h = makeService(remoteError("no working order named 'coid-9'", "order-not-found"));
    const r = await h.service.cancel(cancelIntent());
    expect(r).toMatchObject({
      ok: false,
      blockedBy: "addon-blocked",
      code: "order-not-found",
      certainlyNotDispatched: true,
    });
    expect(h.audit.recentOps()[0]).toMatchObject({ decision: "blocked", denyReason: "order-not-found" });
  });

  it("already-terminal surfaces the terminal state from the message", async () => {
    const h = makeService(
      remoteError("order 'coid-9' is already in terminal state Filled", "already-terminal"),
    );
    const r = await h.service.cancel(cancelIntent());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("already-terminal");
      expect(r.certainlyNotDispatched).toBe(true);
      expect(r.error).toMatch(/Filled/);
    }
  });

  it("a timeout is ambiguous but says retrying is safe", async () => {
    const h = makeService(timeoutError("cancel_order"));
    const r = await h.service.cancel(cancelIntent());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.certainlyNotDispatched).toBe(false);
      expect(r.error).toMatch(/retrying this cancel is safe/);
    }
    expect(h.audit.recentOps()[0]).toMatchObject({ decision: "failed" });
  });

  it("fails fast when the AddOn lacks cancel_order (deploy skew)", async () => {
    const h = withCancelAck({ getAddonCaps: () => ["place_order"] });
    const r = await h.service.cancel(cancelIntent());
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-unsupported", certainlyNotDispatched: true });
    if (!r.ok) expect(r.error).toMatch(/recompile/);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("a pre-caps AddOn (caps=null) also fails fast for new ops", async () => {
    const h = withCancelAck({ getAddonCaps: () => null });
    const r = await h.service.cancel(cancelIntent());
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-unsupported" });
  });
});

describe("ExecutionService.cancelAll / flatten", () => {
  const caIntent: CancelAllIntent = { account: "Sim101", symbol: "MNQ", source: "test" };
  const flIntent: FlattenIntent = { account: "Sim101", symbol: "MNQ", source: "test" };

  it("cancelAll dispatches, carries cancelledCount, audits op row", async () => {
    const h = makeService({
      request: vi.fn(async () => ({
        v: 1,
        id: "x",
        type: "cancel_all_ack",
        contract: "MNQ 09-26",
        cancelledCount: 3,
      })) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.cancelAll(caIntent);
    expect(r).toMatchObject({ ok: true, contract: "MNQ 09-26", cancelledCount: 3 });
    expect(h.audit.recentOps()[0]).toMatchObject({
      op: "cancel-all",
      decision: "dispatched",
      symbol: "MNQ",
      clientOrderId: null,
    });
  });

  it("flatten dispatches with trading disabled (the panic button must work)", async () => {
    const h = makeService({
      loadConfig: () => ({ ...CONFIG, enabled: false }),
      request: vi.fn(async () => ({
        v: 1,
        id: "x",
        type: "flatten_ack",
        contract: "MNQ 09-26",
      })) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.flatten(flIntent);
    expect(r).toMatchObject({ ok: true, contract: "MNQ 09-26" });
    expect(h.audit.recentOps()[0]).toMatchObject({ op: "flatten", decision: "dispatched" });
  });

  it("flatten timeout is ambiguous with retry-safe guidance", async () => {
    const h = makeService(timeoutError("flatten"));
    const r = await h.service.flatten(flIntent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/retrying this flatten is safe/);
  });

  it("instrument-not-found is a definitive block for cancelAll", async () => {
    const h = makeService(remoteError("could not resolve instrument", "instrument-not-found"));
    const r = await h.service.cancelAll(caIntent);
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-blocked", certainlyNotDispatched: true });
  });

  it("cancelAll works with trading DISABLED — risk-reducing kill-switch", async () => {
    const h = makeService({
      loadConfig: () => ({ ...CONFIG, enabled: false, maxQty: 0 }),
      request: vi.fn(async () => ({
        v: 1,
        id: "x",
        type: "cancel_all_ack",
        contract: "MNQ 09-26",
        cancelledCount: 2,
      })) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.cancelAll(caIntent);
    expect(r.ok).toBe(true);
    expect(h.audit.recentOps()[0]).toMatchObject({ op: "cancel-all", decision: "dispatched" });
  });

  it("cancelAll blocks an off-allow-list account", async () => {
    const h = makeService();
    const r = await h.service.cancelAll({ ...caIntent, account: "Apex-1" });
    expect(r).toMatchObject({ ok: false, blockedBy: "account-not-allowed", certainlyNotDispatched: true });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.audit.recentOps()[0]).toMatchObject({ op: "cancel-all", decision: "blocked" });
  });

  it("flatten blocks an off-allow-list account", async () => {
    const h = makeService();
    const r = await h.service.flatten({ ...flIntent, account: "Apex-1" });
    expect(r).toMatchObject({ ok: false, blockedBy: "account-not-allowed", certainlyNotDispatched: true });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.audit.recentOps()[0]).toMatchObject({ op: "flatten", decision: "blocked" });
  });

  it("cancelAll fails fast when the AddOn lacks cancel_all (deploy skew)", async () => {
    const h = makeService({ getAddonCaps: () => ["place_order"] });
    const r = await h.service.cancelAll(caIntent);
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-unsupported", certainlyNotDispatched: true });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("flatten fails fast when the AddOn lacks flatten (deploy skew)", async () => {
    const h = makeService({ getAddonCaps: () => ["place_order"] });
    const r = await h.service.flatten(flIntent);
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-unsupported", certainlyNotDispatched: true });
    expect(h.request).not.toHaveBeenCalled();
  });
});

function changeIntent(over: Partial<ChangeIntent> = {}): ChangeIntent {
  return { account: "Sim101", clientOrderId: "coid-9", limitPrice: 200, source: "test", ...over };
}

function withChangeAck(over: Partial<ExecutionServiceDeps> = {}): Harness {
  return makeService({
    request: vi.fn(async (_t: string, p: Record<string, unknown>) => ({
      v: 1,
      id: "x",
      type: "change_ack",
      clientOrderId: String(p.clientOrderId),
      orderId: "O-9",
      state: "ChangeSubmitted",
      quantity: 1,
      ...(p.limitPrice !== undefined ? { limitPrice: p.limitPrice } : {}),
      ...(p.stopPrice !== undefined ? { stopPrice: p.stopPrice } : {}),
    })) as ExecutionServiceDeps["request"],
    ...over,
  });
}

describe("ExecutionService.change", () => {
  it("dispatches and audits requested values to order_ops", async () => {
    const h = withChangeAck();
    const r = await h.service.change(changeIntent({ quantity: 2 }));
    expect(r).toMatchObject({ ok: true, clientOrderId: "coid-9", state: "ChangeSubmitted" });
    const [type, payload] = h.request.mock.calls[0];
    expect(type).toBe("change_order");
    expect(payload).toEqual({
      account: "Sim101",
      clientOrderId: "coid-9",
      quantity: 2,
      limitPrice: 200,
    });
    expect(h.audit.recentOps()[0]).toMatchObject({
      op: "change",
      decision: "dispatched",
      clientOrderId: "coid-9",
      quantity: 2,
      limitPrice: 200,
      stopPrice: null,
    });
  });

  it("requires at least one changed field", async () => {
    const h = withChangeAck();
    const r = await h.service.change({
      account: "Sim101",
      clientOrderId: "coid-9",
      source: "test",
    });
    expect(r).toMatchObject({ ok: false, blockedBy: "validation" });
    if (!r.ok) expect(r.error).toMatch(/at least one of/);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("rides the FULL gate — blocked when trading is disabled", async () => {
    const h = withChangeAck({ loadConfig: () => ({ ...CONFIG, enabled: false }) });
    const r = await h.service.change(changeIntent());
    expect(r).toMatchObject({ ok: false, blockedBy: "disabled", certainlyNotDispatched: true });
    expect(h.audit.recentOps()[0]).toMatchObject({ op: "change", decision: "blocked" });
  });

  it("qty check bites only when quantity is provided", async () => {
    const h = withChangeAck();
    const over = await h.service.change(changeIntent({ quantity: 99 }));
    expect(over).toMatchObject({ ok: false, blockedBy: "qty-exceeds-max" });
    const priceOnly = await h.service.change(changeIntent());
    expect(priceOnly.ok).toBe(true);
  });

  it("claims a rate slot (limit 1 → second change blocked)", async () => {
    const h = withChangeAck({ loadConfig: () => ({ ...CONFIG, maxOrdersPerMin: 1 }) });
    expect((await h.service.change(changeIntent())).ok).toBe(true);
    const r2 = await h.service.change(changeIntent());
    expect(r2).toMatchObject({ ok: false, blockedBy: "rate-limited" });
  });

  it("notes tick rounding against the requested price", async () => {
    const h = makeService({
      request: vi.fn(async (_t: string, p: Record<string, unknown>) => ({
        v: 1,
        id: "x",
        type: "change_ack",
        clientOrderId: String(p.clientOrderId),
        state: "ChangeSubmitted",
        limitPrice: 200.25,
      })) as ExecutionServiceDeps["request"],
    });
    const r = await h.service.change(changeIntent({ limitPrice: 200.3 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.note).toMatch(/limitPrice rounded to tick: 200.3 → 200.25/);
      expect(r.limitPrice).toBe(200.25);
    }
  });

  it("change timeout is ambiguous with retry-safe guidance", async () => {
    const h = makeService(timeoutError("change_order"));
    const r = await h.service.change(changeIntent());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/retrying this change is safe/);
  });

  it("fails fast when the AddOn lacks change_order (deploy skew)", async () => {
    const h = withChangeAck({ getAddonCaps: () => ["place_order"] });
    const r = await h.service.change(changeIntent());
    expect(r).toMatchObject({ ok: false, blockedBy: "addon-unsupported", certainlyNotDispatched: true });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("a pre-Change state-read failure is a definitive block, not ambiguous", async () => {
    const h = makeService(remoteError("could not read working order state: boom", "state-read-failed"));
    const r = await h.service.change(changeIntent());
    expect(r).toMatchObject({
      ok: false,
      blockedBy: "addon-blocked",
      code: "state-read-failed",
      certainlyNotDispatched: true,
    });
    expect(h.audit.recentOps()[0]).toMatchObject({ decision: "blocked", denyReason: "state-read-failed" });
  });
});

describe("phase-2 validators", () => {
  it("validateOcoIntent rejects non-positive prices", () => {
    expect(validateOcoIntent(ocoExit({ stopPrice: 0 }))).toMatch(/stopPrice/);
    expect(validateOcoIntent(ocoExit({ limitPrice: -1 }))).toMatch(/limitPrice/);
  });
  it("validateOcoIntent accepts a 47-char base", () => {
    expect(validateOcoIntent(ocoExit({ clientOrderId: "x".repeat(47) }))).toBeNull();
  });
  it("validateChangeIntent rejects a bad quantity", () => {
    expect(validateChangeIntent(changeIntent({ quantity: 1.5 }))).toMatch(/quantity/);
  });
});
