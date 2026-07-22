import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "../../db/schema.js";
import { BridgeRequestError } from "../../bridge/connection.js";
import { createOrderAudit, type OrderAudit } from "../audit.js";
import {
  ExecutionService,
  validateIntent,
  type ExecutionServiceDeps,
} from "../service.js";
import type { TradingConfig } from "../config.js";
import type { OrderIntent } from "../types.js";

const CONFIG: TradingConfig = {
  enabled: true,
  allowAccounts: ["Sim101"],
  maxQty: 2,
  maxOrdersPerMin: 0,
};

const NOW_MS = 1_789_000_000_000;
const NOW_UNIX = Math.floor(NOW_MS / 1000);

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
    nowMs: () => NOW_MS,
    nowUnix: () => NOW_UNIX,
    newClientOrderId: () => "coid-1",
    ...over,
  };
  return { service: new ExecutionService(deps), request, audit, ensureFeed };
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

  // --- dispatch-failure classification (A1/A2): by typed error, never by string ---

  function throwing(err: unknown): Partial<ExecutionServiceDeps> {
    return {
      request: vi.fn(async () => {
        throw err;
      }) as ExecutionServiceDeps["request"],
    };
  }

  it("a disconnect WHILE WAITING is ambiguous, NOT certainlyNotSubmitted", async () => {
    // Regression: this used to match /disconnected/ and be reported as certainly
    // not submitted → the caller retried with a fresh id → double order.
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

  it("(B1) claims the rate slot before awaiting — concurrent submits can't both pass (limit 1)", async () => {
    // Hold the feed subscribe open so both submits are in flight at once. The
    // slot must be claimed synchronously (pre-await) or both clear the gate.
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
