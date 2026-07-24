import { describe, it, expect, vi } from "vitest";
import { createPlaceOcoHandler } from "../place-oco.js";
import { createCancelOrderHandler } from "../cancel-order.js";
import { createCancelAllHandler } from "../cancel-all.js";
import { createFlattenHandler } from "../flatten.js";
import { createChangeOrderHandler } from "../change-order.js";
import type { ExecutionService } from "../../execution/service.js";
import type {
  CancelAllIntent,
  CancelIntent,
  CancelResult,
  ChangeIntent,
  ChangeResult,
  OcoIntent,
  OcoResult,
} from "../../execution/types.js";

const OCO_OK: OcoResult = {
  ok: true,
  ocoId: "base",
  clientOrderId: "base",
  contract: "MNQ 09-26",
  stop: { clientOrderId: "base:S", orderId: null, state: "Submitted" },
  target: { clientOrderId: "base:T", orderId: null, state: "Submitted" },
  deduped: false,
};

describe("place_oco handler", () => {
  it("maps args to an OcoIntent with source claude and optional base id", async () => {
    const submitOco = vi.fn(async (_i: OcoIntent) => OCO_OK);
    const svc = { submitOco } as unknown as ExecutionService;
    const handler = createPlaceOcoHandler(() => svc);
    const res = await handler({
      account: "Sim101",
      symbol: "MNQ",
      action: "Sell",
      quantity: 1,
      stopPrice: 100,
      limitPrice: 200,
      tif: "Gtc",
      reason: "bracket",
    });
    expect(res.isError).toBeUndefined();
    const intent = submitOco.mock.calls[0][0];
    expect(intent).toMatchObject({
      account: "Sim101",
      action: "Sell",
      stopPrice: 100,
      limitPrice: 200,
      source: "claude",
      reason: "bracket",
    });
    expect(intent.clientOrderId).toBeUndefined();
  });

  it("surfaces blockedBy / certainlyNotSubmitted on failure", async () => {
    const svc = {
      submitOco: vi.fn(async () => ({
        ok: false as const,
        clientOrderId: "base",
        error: "trading is disabled",
        blockedBy: "disabled" as const,
        certainlyNotSubmitted: true,
      })),
    } as unknown as ExecutionService;
    const handler = createPlaceOcoHandler(() => svc);
    const res = await handler({
      account: "Sim101",
      symbol: "MNQ",
      action: "Sell",
      quantity: 1,
      stopPrice: 100,
      limitPrice: 200,
      tif: "Gtc",
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({
      clientOrderId: "base",
      blockedBy: "disabled",
      certainlyNotSubmitted: true,
    });
  });
});

describe("cancel_order handler", () => {
  it("maps args and surfaces the ok result", async () => {
    const ok: CancelResult = {
      ok: true,
      clientOrderId: "coid-1",
      orderId: "O-1",
      state: "CancelSubmitted",
    };
    const cancel = vi.fn(async (_i: CancelIntent) => ok);
    const svc = { cancel } as unknown as ExecutionService;
    const handler = createCancelOrderHandler(() => svc);
    const res = await handler({ account: "Sim101", clientOrderId: "coid-1" });
    expect(res.isError).toBeUndefined();
    expect(cancel.mock.calls[0][0]).toMatchObject({
      account: "Sim101",
      clientOrderId: "coid-1",
      source: "claude",
    });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ state: "CancelSubmitted" });
  });

  it("carries the machine-readable code on failure (already-terminal)", async () => {
    const svc = {
      cancel: vi.fn(async () => ({
        ok: false as const,
        clientOrderId: "coid-1",
        error: "order 'coid-1' is already in terminal state Filled",
        blockedBy: "addon-blocked" as const,
        code: "already-terminal",
        certainlyNotDispatched: true,
      })),
    } as unknown as ExecutionService;
    const handler = createCancelOrderHandler(() => svc);
    const res = await handler({ account: "Sim101", clientOrderId: "coid-1" });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ code: "already-terminal", certainlyNotDispatched: true });
  });
});

describe("cancel_all / flatten handlers", () => {
  it("cancel_all maps args and surfaces cancelledCount", async () => {
    const cancelAll = vi.fn(async (_i: CancelAllIntent) => ({
      ok: true as const,
      contract: "MNQ 09-26",
      cancelledCount: 2,
    }));
    const svc = { cancelAll } as unknown as ExecutionService;
    const handler = createCancelAllHandler(() => svc);
    const res = await handler({ account: "Sim101", symbol: "MNQ" });
    expect(cancelAll.mock.calls[0][0]).toMatchObject({ symbol: "MNQ", source: "claude" });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ cancelledCount: 2 });
  });

  it("flatten maps args and surfaces failures with certainlyNotDispatched", async () => {
    const svc = {
      flatten: vi.fn(async () => ({
        ok: false as const,
        error: "NinjaTrader bridge not connected",
        blockedBy: "not-connected" as const,
        certainlyNotDispatched: true,
      })),
    } as unknown as ExecutionService;
    const handler = createFlattenHandler(() => svc);
    const res = await handler({ account: "Sim101", symbol: "MNQ" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      blockedBy: "not-connected",
      certainlyNotDispatched: true,
    });
  });
});

describe("change_order handler", () => {
  it("only forwards the fields the caller provided", async () => {
    const ok: ChangeResult = {
      ok: true,
      clientOrderId: "coid-1",
      orderId: null,
      state: "ChangeSubmitted",
    };
    const change = vi.fn(async (_i: ChangeIntent) => ok);
    const svc = { change } as unknown as ExecutionService;
    const handler = createChangeOrderHandler(() => svc);
    await handler({ account: "Sim101", clientOrderId: "coid-1", stopPrice: 101.5 });
    const intent = change.mock.calls[0][0];
    expect(intent).toMatchObject({ clientOrderId: "coid-1", stopPrice: 101.5, source: "claude" });
    expect(intent).not.toHaveProperty("quantity");
    expect(intent).not.toHaveProperty("limitPrice");
  });
});
