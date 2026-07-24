import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isTradingRegistrationEnabled,
  isRiskReducingRegistrationEnabled,
} from "../config.js";

// Registration matrix (TRADING.md); process.env wins over .env.local, so these two keys fully determine the verdict.
describe("write-tool registration matrix", () => {
  const KEYS = ["NT_TRADING_ENABLED", "NT_TRADING_ALLOW_ACCOUNTS"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  function set(enabled: string, accounts: string): void {
    process.env.NT_TRADING_ENABLED = enabled;
    process.env.NT_TRADING_ALLOW_ACCOUNTS = accounts;
  }

  it("enabled + allow-listed → both classes register", () => {
    set("1", "Sim101");
    expect(isTradingRegistrationEnabled()).toBe(true);
    expect(isRiskReducingRegistrationEnabled()).toBe(true);
  });

  it("disabled + allow-listed → only risk-reducing (kill-switch)", () => {
    set("0", "Sim101");
    expect(isTradingRegistrationEnabled()).toBe(false);
    expect(isRiskReducingRegistrationEnabled()).toBe(true);
  });

  it("enabled + EMPTY allow-list → NONE (risk-adding needs an account too)", () => {
    set("1", "");
    expect(isTradingRegistrationEnabled()).toBe(false);
    expect(isRiskReducingRegistrationEnabled()).toBe(false);
  });

  it("disabled + empty allow-list → none", () => {
    set("0", "");
    expect(isTradingRegistrationEnabled()).toBe(false);
    expect(isRiskReducingRegistrationEnabled()).toBe(false);
  });
});
