import { describe, it, expect } from "vitest";
import { createDrawHandler } from "../draw.js";
import type { OutboundMessage } from "../../bridge/protocol.js";

function harness(connected = true) {
  const sent: OutboundMessage[] = [];
  const handler = createDrawHandler({
    isConnected: () => connected,
    send: (m) => {
      sent.push(m);
      return true;
    },
  });
  return { handler, sent };
}

describe("draw tool", () => {
  it("sends a rectangle draw message with style", async () => {
    const { handler, sent } = harness();
    await handler({
      id: "z1",
      symbol: "NQ",
      shape: { kind: "rectangle", proximal: 25000, distal: 24990, fromTs: 100, toTs: 200 },
      style: { color: "#22c55e", opacity: 0.25, label: "ENTRY" },
    });
    expect(sent).toEqual([
      {
        v: 1,
        type: "draw",
        id: "z1",
        symbol: "NQ",
        shape: { kind: "rectangle", proximal: 25000, distal: 24990, fromTs: 100, toTs: 200 },
        style: { color: "#22c55e", opacity: 0.25, label: "ENTRY" },
      },
    ]);
  });

  it("sends an hline with no style", async () => {
    const { handler, sent } = harness();
    await handler({ id: "h1", symbol: "NQ", shape: { kind: "hline", price: 2000 } });
    expect(sent[0]).toMatchObject({ type: "draw", id: "h1", shape: { kind: "hline", price: 2000 } });
    expect((sent[0] as any).style).toBeUndefined();
  });

  it("sends a text shape", async () => {
    const { handler, sent } = harness();
    await handler({ id: "t1", symbol: "NQ", shape: { kind: "text", ts: 100, price: 25000, text: "hi" } });
    expect(sent[0]).toMatchObject({ shape: { kind: "text", text: "hi", ts: 100, price: 25000 } });
  });

  it("does not send when NT is disconnected", async () => {
    const { handler, sent } = harness(false);
    const res = await handler({ id: "x", symbol: "NQ", shape: { kind: "vline", ts: 100 } });
    expect(sent).toHaveLength(0);
    expect(res.content[0].text).toMatch(/not connected/i);
  });
});
