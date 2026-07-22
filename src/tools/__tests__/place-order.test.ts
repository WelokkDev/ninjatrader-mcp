import { describe, it, expect, vi } from "vitest";
import { createPlaceOrderHandler } from "../place-order.js";
import type { ExecutionService } from "../../execution/service.js";
import type { OrderIntent, OrderResult } from "../../execution/types.js";

const OK: OrderResult = {
  ok: true,
  clientOrderId: "coid",
  contract: "MNQ 09-26",
  orderId: null,
  state: "Submitted",
  deduped: false,
};

function fakeService(result: OrderResult = OK) {
  const submit = vi.fn(async (_intent: OrderIntent) => result);
  const svc = { submit } as unknown as ExecutionService;
  return { svc, submit };
}

const baseArgs = {
  account: "Sim101",
  symbol: "MNQ",
  action: "Buy" as const,
  orderType: "Market" as const,
  quantity: 1,
  tif: "Day" as const,
};

describe("place_order handler", () => {
  it("passes an explicit clientOrderId through to the intent (retry path)", async () => {
    const { svc, submit } = fakeService();
    const handler = createPlaceOrderHandler(() => svc);
    await handler({ ...baseArgs, clientOrderId: "retry-1" });
    expect(submit).toHaveBeenCalledOnce();
    const intent = submit.mock.calls[0][0];
    expect(intent.clientOrderId).toBe("retry-1");
    expect(intent.source).toBe("claude");
  });

  it("omits clientOrderId from the intent when the caller doesn't pass one", async () => {
    const { svc, submit } = fakeService();
    const handler = createPlaceOrderHandler(() => svc);
    await handler({ ...baseArgs });
    const intent = submit.mock.calls[0][0];
    expect(intent.clientOrderId).toBeUndefined();
  });

  it("surfaces certainlyNotSubmitted / blockedBy on failure", async () => {
    const { svc } = fakeService({
      ok: false,
      clientOrderId: "coid",
      error: "AddOn trading gate disabled",
      blockedBy: "addon-blocked",
      certainlyNotSubmitted: true,
    });
    const handler = createPlaceOrderHandler(() => svc);
    const res = await handler({ ...baseArgs });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ blockedBy: "addon-blocked", certainlyNotSubmitted: true });
  });
});
