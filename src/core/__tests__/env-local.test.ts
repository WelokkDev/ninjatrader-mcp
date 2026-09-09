import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { envSetting, readEnvFile } from "../env-local.js";

const dirs: string[] = [];

function envFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nt-envlocal-"));
  dirs.push(dir);
  const file = path.join(dir, ".env.local");
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.NT_BRIDGE_HOST;
});

describe("env-local", () => {
  it("reads a setting from the file", () => {
    const file = envFile("NT_BRIDGE_HOST=10.211.55.2\n");
    expect(envSetting("NT_BRIDGE_HOST", file)).toBe("10.211.55.2");
  });

  it("lets real process env win over the file", () => {
    const file = envFile("NT_BRIDGE_HOST=10.211.55.2\n");
    process.env.NT_BRIDGE_HOST = "127.0.0.1";
    expect(envSetting("NT_BRIDGE_HOST", file)).toBe("127.0.0.1");
  });

  it("treats an absent file as unset rather than throwing", () => {
    // The Windows-desktop case: no host line anywhere, so the caller falls
    // back to the loopback default and behavior is unchanged.
    const missing = path.join(tmpdir(), "nt-envlocal-does-not-exist", ".env.local");
    expect(envSetting("NT_BRIDGE_HOST", missing)).toBeUndefined();
  });

  it("treats an empty or whitespace value as unset", () => {
    const file = envFile("NT_BRIDGE_HOST=   \n");
    expect(envSetting("NT_BRIDGE_HOST", file)).toBeUndefined();
  });

  it("ignores comments and blank lines, and keeps '=' inside values", () => {
    const file = envFile("# a comment\n\nNT_BRIDGE_TOKEN=ab=cd\n");
    const map = readEnvFile(file);
    expect(map.get("NT_BRIDGE_TOKEN")).toBe("ab=cd");
    expect(map.has("# a comment")).toBe(false);
  });
});
