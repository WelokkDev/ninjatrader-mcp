import { describe, it, expect } from "vitest";
import { evaluateGate, evaluateRiskReducingGate } from "../gate.js";
import type { TradingConfig } from "../config.js";

const CONFIG: TradingConfig = {
  enabled: true,
  allowAccounts: ["Sim101"],
  maxQty: 2,
  maxOrdersPerMin: 3,
};

const NOW = 1_789_000_000_000;
const noRecent = { recentSubmitsMs: [], nowMs: NOW };

describe("evaluateGate", () => {
  it("allows an in-policy order", () => {
    const v = evaluateGate({ account: "Sim101", quantity: 2 }, CONFIG, noRecent);
    expect(v.allowed).toBe(true);
  });

  it("blocks when disabled, before any other check", () => {
    const v = evaluateGate(
      { account: "Sim101", quantity: 1 },
      { ...CONFIG, enabled: false },
      noRecent,
    );
    expect(v).toMatchObject({ allowed: false, reason: "disabled" });
  });

  it("blocks an account off the allow-list", () => {
    const v = evaluateGate({ account: "Apex-99", quantity: 1 }, CONFIG, noRecent);
    expect(v).toMatchObject({ allowed: false, reason: "account-not-allowed" });
  });

  it("blocks quantity over the cap", () => {
    const v = evaluateGate({ account: "Sim101", quantity: 3 }, CONFIG, noRecent);
    expect(v).toMatchObject({ allowed: false, reason: "qty-exceeds-max" });
  });

  it("empty allow-list rejects everything", () => {
    const v = evaluateGate(
      { account: "Sim101", quantity: 1 },
      { ...CONFIG, allowAccounts: [] },
      noRecent,
    );
    expect(v).toMatchObject({ allowed: false, reason: "account-not-allowed" });
  });

  it("rate-limits once the rolling window is full", () => {
    const recent = { recentSubmitsMs: [NOW - 100, NOW - 200, NOW - 300], nowMs: NOW };
    const v = evaluateGate({ account: "Sim101", quantity: 1 }, CONFIG, recent);
    expect(v).toMatchObject({ allowed: false, reason: "rate-limited" });
  });

  it("ignores rate entries outside the 60s window", () => {
    const recent = {
      recentSubmitsMs: [NOW - 61_000, NOW - 62_000, NOW - 63_000],
      nowMs: NOW,
    };
    const v = evaluateGate({ account: "Sim101", quantity: 1 }, CONFIG, recent);
    expect(v.allowed).toBe(true);
  });

  it("treats maxOrdersPerMin=0 as unlimited", () => {
    const recent = { recentSubmitsMs: [NOW, NOW, NOW, NOW, NOW], nowMs: NOW };
    const v = evaluateGate(
      { account: "Sim101", quantity: 1 },
      { ...CONFIG, maxOrdersPerMin: 0 },
      recent,
    );
    expect(v.allowed).toBe(true);
  });
});

describe("evaluateRiskReducingGate", () => {
  it("passes an allow-listed account even with enabled=false (locked policy)", () => {
    const v = evaluateRiskReducingGate("Sim101", { ...CONFIG, enabled: false });
    expect(v.allowed).toBe(true);
  });

  it("blocks an account off the allow-list", () => {
    const v = evaluateRiskReducingGate("Apex-99", CONFIG);
    expect(v).toMatchObject({ allowed: false, reason: "account-not-allowed" });
  });

  it("empty allow-list blocks everything (fail-closed default)", () => {
    const v = evaluateRiskReducingGate("Sim101", { ...CONFIG, allowAccounts: [] });
    expect(v).toMatchObject({ allowed: false, reason: "account-not-allowed" });
  });

  it("ignores the qty cap entirely (maxQty=0 still passes)", () => {
    const v = evaluateRiskReducingGate("Sim101", { ...CONFIG, maxQty: 0, enabled: false });
    expect(v.allowed).toBe(true);
  });
});
