import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { loadNinjaTraderConfig } from "../get-trades.js";

// loadNinjaTraderConfig resolves NT8's trade DB from, in order: NT_TRADES_DB_PATH,
// NT_TRADES_CONFIG, then the repo-root JSON. Only the first two are exercised
// here — the third depends on a file that may or may not exist in a checkout.

const dirs: string[] = [];

function configFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nt-trades-cfg-"));
  dirs.push(dir);
  const file = path.join(dir, "ninjatrader.config.json");
  writeFileSync(file, contents);
  return file;
}

/**
 * An .env.local that does not exist. Without this the suite would read the
 * developer's real .env.local, and any NT_TRADES_DB_PATH they have set for
 * their own machine would silently win over these fixtures.
 */
function noEnvFile(): string {
  return path.join(tmpdir(), "nt-trades-no-env-local", ".env.local");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.NT_TRADES_DB_PATH;
  delete process.env.NT_TRADES_ACCOUNT;
  delete process.env.NT_TRADES_CONFIG;
});

describe("loadNinjaTraderConfig", () => {
  it("takes dbPath from NT_TRADES_DB_PATH with no config file present", () => {
    process.env.NT_TRADES_DB_PATH = "/Users/x/Documents/NinjaTrader 8/db/NinjaTrader.sqlite";
    expect(loadNinjaTraderConfig(noEnvFile())).toEqual({
      dbPath: "/Users/x/Documents/NinjaTrader 8/db/NinjaTrader.sqlite",
    });
  });

  it("pairs NT_TRADES_ACCOUNT with the env dbPath", () => {
    process.env.NT_TRADES_DB_PATH = "/tmp/NinjaTrader.sqlite";
    process.env.NT_TRADES_ACCOUNT = "Sim101";
    expect(loadNinjaTraderConfig(noEnvFile())).toEqual({ dbPath: "/tmp/NinjaTrader.sqlite", account: "Sim101" });
  });

  it("omits account when NT_TRADES_ACCOUNT is unset, so all accounts import", () => {
    process.env.NT_TRADES_DB_PATH = "/tmp/NinjaTrader.sqlite";
    expect(loadNinjaTraderConfig(noEnvFile()).account).toBeUndefined();
  });

  it("beats a config file that points somewhere else", () => {
    process.env.NT_TRADES_CONFIG = configFile('{ "dbPath": "C:/from-file.sqlite" }');
    process.env.NT_TRADES_DB_PATH = "/from-env.sqlite";
    expect(loadNinjaTraderConfig(noEnvFile()).dbPath).toBe("/from-env.sqlite");
  });

  it("still falls back to the config file when no env path is set", () => {
    process.env.NT_TRADES_CONFIG = configFile(
      '{ "dbPath": "C:/from-file.sqlite", "account": "Live1" }',
    );
    expect(loadNinjaTraderConfig(noEnvFile())).toEqual({ dbPath: "C:/from-file.sqlite", account: "Live1" });
  });

  it("reads NT_TRADES_DB_PATH out of an .env.local file, not just process env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nt-trades-env-"));
    dirs.push(dir);
    const envFile = path.join(dir, ".env.local");
    writeFileSync(envFile, "NT_TRADES_DB_PATH=/from-env-local.sqlite\nNT_TRADES_ACCOUNT=Sim101\n");
    expect(loadNinjaTraderConfig(envFile)).toEqual({
      dbPath: "/from-env-local.sqlite",
      account: "Sim101",
    });
  });

  it("names both routes when neither is available", () => {
    process.env.NT_TRADES_CONFIG = path.join(tmpdir(), "nt-does-not-exist", "cfg.json");
    expect(() => loadNinjaTraderConfig(noEnvFile())).toThrow(/NT_TRADES_DB_PATH is not set/);
  });
});
