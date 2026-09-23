import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envSetting } from "../core/env-local.js";

/** Loopback only: this port executes tools. */
export const HUB_HOST = "127.0.0.1";
// 9472 is the bridge; 9473 is a common pick for local dashboards, so skip it.
export const DEFAULT_HUB_PORT = 9474;
export const HUB_TOKEN_KEY = "NT_HUB_TOKEN";
/** Long enough for a restarting client to reattach. */
export const HUB_IDLE_EXIT_MS = 90_000;

// Here rather than in daemon.ts so the shim never loads the server stack.
export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";
export const SHUTDOWN_PATH = "/shutdown";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..");
// Not from `here`, which is src/hub under vitest.
export const BUILD_DIR = path.join(REPO_ROOT, "build");

export function hubPort(): number {
  const raw = envSetting("NT_HUB_PORT");
  if (raw === undefined) return DEFAULT_HUB_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`invalid NT_HUB_PORT (${raw})`);
  return n;
}

export function hubBaseUrl(port: number): string {
  return `http://${HUB_HOST}:${port}`;
}

/** Same resolution as db/connection.ts, without opening the database. */
export function dataDir(): string {
  const p = process.env.NT_DATA_PATH;
  return p ? path.resolve(p) : path.join(REPO_ROOT, "data");
}

export interface BuildFingerprint {
  newestMtimeMs: number;
  files: number;
}

export interface HubHealth {
  ok: true;
  name: string;
  version: string;
  pid: number;
  port: number;
  startedAtMs: number;
  ready: boolean;
  resident: boolean;
  sessions: number;
  build: BuildFingerprint;
}

export function buildFingerprint(dir: string = BUILD_DIR): BuildFingerprint {
  let newest = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".js")) {
        files++;
        try {
          const m = statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          // Raced with a rebuild; the next probe sees the new tree.
        }
      }
    }
  };
  walk(dir);
  return { newestMtimeMs: Math.round(newest), files };
}
