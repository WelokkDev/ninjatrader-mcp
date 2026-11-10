import { describe, expect, it } from "vitest";
import { INBOUND_SCHEMAS, OUTBOUND_SCHEMAS } from "../../src/bridge/protocol.js";
import { REGISTRY } from "../../src/core/sessions/registry.js";
import { CME_US_INDEX_FUTURES_ETH } from "../../src/core/sessions/templates.js";
import {
  CANCEL_ALL_SPEC,
  CANCEL_SPEC,
  CHANGE_SPEC,
  FLATTEN_SPEC,
  ocoSpec,
  placeSpec,
  type DispatchSpec,
} from "../../src/execution/service.js";
import { CHART_INDICATORS_TIMEOUT_MS } from "../../src/tools/list-chart-indicators.js";
import { OPEN_CHARTS_TIMEOUT_MS } from "../../src/tools/list-open-charts.js";
import { NAVIGATE_CHART_TIMEOUT_MS } from "../../src/tools/navigate-chart.js";
import { GET_DRAWINGS_TIMEOUT_MS } from "../../src/tools/read-drawings.js";
import {
  INDICATOR_VALUES_MAX_POINTS,
  INDICATOR_VALUES_TIMEOUT_MS,
} from "../../src/tools/read-indicator-values.js";
import { CSharpSource, deepKeys, repoFile, stringLiteral, topLevelKeys } from "./source-scan.js";

const cs = new CSharpSource(repoFile("ninja-addon/addons/mcp-bridge.cs"));

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/** Top-level labels only, so a nested switch's cases don't count. */
function dispatchCases(): Map<string, { from: number; to: number }> {
  const switches = [...cs.codeMatches(/switch\s*\(\s*type\s*\)\s*\{/)];
  expect(switches, "expected one `switch (type)` in the AddOn").toHaveLength(1);
  const open = switches[0].index! + switches[0][0].length - 1;
  const close = cs.closing(open);
  const labels = [...cs.codeMatches(/\b(?:case\s+"(\w+)"|default)\s*:/, open, close)].filter(
    (m) => {
      const before = cs.masked.slice(open, m.index);
      return before.split("{").length - before.split("}").length === 1;
    },
  );
  const cases = new Map<string, { from: number; to: number }>();
  labels.forEach((m, i) => {
    if (m[1]) cases.set(m[1], { from: m.index!, to: labels[i + 1]?.index ?? close });
  });
  return cases;
}

/** Top-level keys only: initializer entries plus later `payload["key"] = …` in the same method. */
function emittedMessages(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of cs.codeMatches(/\{\s*"type"\s*,\s*"(\w+)"\s*\}/)) {
    let depth = 0;
    let init = m.index! - 1;
    for (; init >= 0; init--) {
      const ch = cs.masked[init];
      if (ch === "}") depth++;
      else if (ch === "{" && depth-- === 0) break;
    }
    const head = /(?:(\w+)\s*=\s*)?new Dictionary<string,\s*object>\s*$/.exec(
      cs.src.slice(Math.max(0, init - 200), init),
    );
    expect(head, `"${m[1]}" is not built as a Dictionary<string, object>`).not.toBeNull();
    const end = cs.closing(init);

    const keys = out.get(m[1]) ?? new Set<string>();
    for (let i = init + 1; i < end; i++) {
      if (cs.masked[i] !== "{") continue;
      const key = /^\{\s*"(\w+)"/.exec(cs.src.slice(i, i + 200));
      if (key) keys.add(key[1]);
      i = cs.closing(i);
    }
    const variable = head![1];
    if (variable) {
      const method = cs.enclosingMethod(m.index!);
      const assign = new RegExp(`\\b${variable}\\["(\\w+)"\\]\\s*=(?!=)`);
      for (const a of cs.codeMatches(assign, end, method.end)) keys.add(a[1]);
    }
    out.set(m[1], keys);
  }
  return out;
}

const dictionaryReaders = new Set(
  cs.methods.filter((m) => m.name.startsWith("Get") && m.takesDictionary).map((m) => m.name),
);

/** Literal `GetX(dict, "key")` keys in the case body and dictionary-taking methods it reaches. */
function keysRead(range: { from: number; to: number }): Set<string> {
  const ranges = [
    range,
    ...cs
      .reachable(range.from, range.to, (m) => m.takesDictionary && !dictionaryReaders.has(m.name))
      .map((m) => ({ from: m.start, to: m.end })),
  ];
  const keys = new Set<string>();
  for (const r of ranges) {
    for (const m of cs.codeMatches(/\b(Get\w*)\s*\(\s*\w+\s*,\s*"(\w+)"\s*\)/, r.from, r.to)) {
      if (dictionaryReaders.has(m[1])) keys.add(m[2]);
    }
  }
  return keys;
}

function errorCodes(range: { from: number; to: number }): { codes: Set<string>; dynamic: string[] } {
  const ranges = [range, ...cs.reachable(range.from, range.to).map((m) => ({ from: m.start, to: m.end }))];
  const codes = new Set<string>();
  const dynamic: string[] = [];
  for (const r of ranges) {
    for (const m of cs.codeMatches(/\bSendErrorResponse\s*\(/, r.from, r.to)) {
      const args = cs.args(m.index! + m[0].length - 1);
      if (args.length < 3 || args[2] === "null") continue;
      const code = stringLiteral(args[2]);
      if (code === null) dynamic.push(args[2]);
      else codes.add(code);
    }
  }
  return { codes, dynamic };
}

function csIntConst(name: string): number {
  const m = new RegExp(`const\\s+(?:int|long)\\s+${name}\\s*=\\s*([\\d_]+)\\s*;`).exec(cs.src);
  if (!m) throw new Error(`no int constant ${name} in the AddOn`);
  return Number(m[1].replace(/_/g, ""));
}

describe("message types", () => {
  it("the AddOn sends exactly the types parseMessage accepts", () => {
    expect(sorted(emittedMessages().keys())).toEqual(sorted(Object.keys(INBOUND_SCHEMAS)));
  });

  it("the AddOn handles exactly the types the server sends", () => {
    expect(sorted(dispatchCases().keys())).toEqual(sorted(Object.keys(OUTBOUND_SCHEMAS)));
  });

  it.each([...Object.entries(INBOUND_SCHEMAS), ...Object.entries(OUTBOUND_SCHEMAS)])(
    "%s maps to the schema with that type",
    (key, schema) => {
      expect(schema.shape.type.value).toBe(key);
    },
  );
});

describe("field names", () => {
  const emitted = emittedMessages();

  it.each(Object.keys(INBOUND_SCHEMAS))("%s: the AddOn sets only keys the schema has", (type) => {
    const schema = topLevelKeys(INBOUND_SCHEMAS[type as keyof typeof INBOUND_SCHEMAS]);
    const unknown = sorted([...(emitted.get(type) ?? [])].filter((k) => !schema.all.has(k)));
    expect(unknown, "zod strips unknown keys, so these never reach the server").toEqual([]);
  });

  it.each(Object.keys(INBOUND_SCHEMAS))("%s: the AddOn sets every required key", (type) => {
    const schema = topLevelKeys(INBOUND_SCHEMAS[type as keyof typeof INBOUND_SCHEMAS]);
    const sent = emitted.get(type) ?? new Set();
    const missing = sorted([...schema.required].filter((k) => !sent.has(k)));
    expect(missing, "parseMessage would drop every such message").toEqual([]);
  });

  const cases = dispatchCases();
  it.each(Object.keys(OUTBOUND_SCHEMAS))("%s: the AddOn reads only keys the schema has", (type) => {
    const range = cases.get(type);
    expect(range, `no case for ${type}`).toBeDefined();
    const schema = deepKeys(OUTBOUND_SCHEMAS[type as keyof typeof OUTBOUND_SCHEMAS]);
    const unknown = sorted([...keysRead(range!)].filter((k) => !schema.keys.has(k)));
    expect(unknown, "the server never sends these, so the AddOn reads null").toEqual([]);
  });
});

describe("order rejection codes", () => {
  const SPECS: Record<string, DispatchSpec> = {
    place_order: placeSpec("coid"),
    place_oco: ocoSpec("coid"),
    cancel_order: CANCEL_SPEC,
    cancel_all: CANCEL_ALL_SPEC,
    flatten: FLATTEN_SPEC,
    change_order: CHANGE_SPEC,
  };
  const AMBIGUOUS_BY_DESIGN = new Set(["in-flight"]);
  const cases = dispatchCases();

  it.each(Object.keys(SPECS))("%s: AddOn codes and service.ts classification agree", (op) => {
    const spec = SPECS[op];
    const classified = new Set([
      ...spec.definitiveCodes,
      ...spec.ambiguousCodes,
      ...Object.keys(spec.special ?? {}),
    ]);
    const range = cases.get(op);
    expect(range, `no case for ${op}`).toBeDefined();
    const { codes, dynamic } = errorCodes(range!);

    expect(dynamic, "codes must be string literals to be checked").toEqual([]);
    expect(
      sorted([...codes].filter((c) => !classified.has(c) && !AMBIGUOUS_BY_DESIGN.has(c))),
      "raised by the AddOn but unclassified, so reported as 'may have been submitted'",
    ).toEqual([]);
    expect(
      sorted([...classified].filter((c) => !codes.has(c))),
      "classified in service.ts but never raised by the AddOn for this op",
    ).toEqual([]);
  });
});

describe("constants", () => {
  it("IndicatorValuesMaxPoints", () => {
    expect(csIntConst("IndicatorValuesMaxPoints")).toBe(INDICATOR_VALUES_MAX_POINTS);
  });

  it("QuarterlyIndexRoots are REGISTRY's CME index futures", () => {
    const m = /QuarterlyIndexRoots\s*=\s*new HashSet<string>\([^)]*\)\s*\{([^}]*)\}/.exec(cs.src);
    expect(m, "QuarterlyIndexRoots initializer not found").not.toBeNull();
    const roots = [...m![1].matchAll(/"(\w+)"/g)].map((r) => r[1]);
    const indexFutures = Object.entries(REGISTRY)
      .filter(([, c]) => c.session === CME_US_INDEX_FUTURES_ETH)
      .map(([symbol]) => symbol);
    expect(sorted(roots)).toEqual(sorted(indexFutures));
  });

  it.each([
    ["OpenChartsBudgetMs", OPEN_CHARTS_TIMEOUT_MS],
    ["DrawingsBudgetMs", GET_DRAWINGS_TIMEOUT_MS],
    ["NavigateChartBudgetMs", NAVIGATE_CHART_TIMEOUT_MS],
    ["ChartIndicatorsBudgetMs", CHART_INDICATORS_TIMEOUT_MS],
    ["IndicatorValuesBudgetMs", INDICATOR_VALUES_TIMEOUT_MS],
  ])("server timeout outlasts the AddOn's %s", (budget, timeoutMs) => {
    expect(timeoutMs).toBeGreaterThan(csIntConst(budget));
  });
});
