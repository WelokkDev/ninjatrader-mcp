import { describe, it, expect, vi } from "vitest";
import { createClearZonesHandler } from "../clear-zones.js";
import { createDrawHandler } from "../draw.js";
import { drawingCount } from "../session.js";
import type { OutboundMessage } from "../../bridge/protocol.js";

function harness(drawn = new Map<string, Set<string>>()) {
  const sent: OutboundMessage[] = [];
  const send = vi.fn((m: OutboundMessage) => {
    sent.push(m);
    return true;
  });
  const clear = createClearZonesHandler({ isConnected: () => true, send, drawn });
  const draw = createDrawHandler({ isConnected: () => true, send, knownInstruments: () => ["NQ"], drawn });
  return { sent, clear, draw, drawn };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const rect = { kind: "rectangle" as const, proximal: 10, distal: 9 };

describe("clear_zones scope", () => {
  it("with no ids clears only what this caller drew, then forgets them", async () => {
    const h = harness();
    await h.draw({ id: "a", symbol: "NQ", shape: rect });
    await h.draw({ id: "b", symbol: "ES", shape: rect });
    expect(h.drawn).toEqual(new Map([["NQ", new Set(["a"])], ["ES", new Set(["b"])]]));

    const out = parse(await h.clear({}));
    expect(out).toMatchObject({ dispatched: true, scope: "own", ids: ["a", "b"] });
    expect(h.sent.at(-1)).toMatchObject({ type: "clear_zones", ids: ["a", "b"] });
    expect(h.drawn.size).toBe(0);
  });

  it("a symbol narrows the own scope to that chart's drawings", async () => {
    const h = harness();
    await h.draw({ id: "a", symbol: "NQ", shape: rect });
    await h.draw({ id: "b", symbol: "ES", shape: rect });
    const out = parse(await h.clear({ symbol: "ES" }));
    expect(out.ids).toEqual(["b"]);
    expect(h.sent.at(-1)).toMatchObject({ symbol: "ES", ids: ["b"] });
    expect(h.drawn).toEqual(new Map([["NQ", new Set(["a"])]]));
  });

  it("refuses to clear when this caller drew nothing, pointing at ids and all", async () => {
    const h = harness();
    const res = await h.clear({});
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/all:true/);
    expect(h.sent).toHaveLength(0);
  });

  it("all:true clears everything, as before, and forgets every own drawing", async () => {
    const h = harness();
    await h.draw({ id: "a", symbol: "NQ", shape: rect });
    const out = parse(await h.clear({ all: true }));
    expect(out.scope).toBe("all");
    expect(h.sent.at(-1)).toEqual({ v: 1, type: "clear_zones" });
    expect(h.drawn.size).toBe(0);
  });

  it("explicit ids are sent as given, whoever drew them", async () => {
    const h = harness();
    const out = parse(await h.clear({ ids: ["someone-elses"] }));
    expect(out).toMatchObject({ scope: "ids", ids: ["someone-elses"] });
    expect(h.sent.at(-1)).toMatchObject({ ids: ["someone-elses"] });
  });

  it("two callers keep separate scopes", async () => {
    const a = harness();
    const b = harness();
    await a.draw({ id: "a1", symbol: "NQ", shape: rect });
    await b.draw({ id: "b1", symbol: "NQ", shape: rect });
    const out = parse(await a.clear({}));
    expect(out.ids).toEqual(["a1"]);
    expect(b.drawn).toEqual(new Map([["NQ", new Set(["b1"])]]));
  });

  it("tracks the same id on two charts separately", async () => {
    const h = harness();
    await h.draw({ id: "support-1", symbol: "NQ", shape: rect });
    await h.draw({ id: "support-1", symbol: "ES", shape: rect });
    expect(drawingCount(h.drawn)).toBe(2);
    expect(parse(await h.clear({ symbol: "NQ" }))).toMatchObject({ scope: "own", ids: ["support-1"] });
    expect(h.sent.at(-1)).toMatchObject({ symbol: "NQ", ids: ["support-1"] });
    expect(parse(await h.clear({ symbol: "ES" }))).toMatchObject({ scope: "own", ids: ["support-1"] });
  });

  it("an explicit-ids clear on one chart forgets only that chart's drawings", async () => {
    const h = harness();
    await h.draw({ id: "lvl", symbol: "NQ", shape: rect });
    await h.draw({ id: "x", symbol: "ES", shape: rect });
    await h.clear({ symbol: "ES", ids: ["x", "lvl"] });
    expect(parse(await h.clear({}))).toMatchObject({ scope: "own", ids: ["lvl"] });
  });
});
