import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Machine-local settings, gitignored. This is the one seam for values that
 * differ per machine and must never reach the tracked tree: the shared bridge
 * token, the bind host/port when NT8 lives somewhere other than this machine's
 * loopback (e.g. a Parallels/VMware guest).
 */
export const ENV_FILE = path.join(__dirname, "..", "..", ".env.local");

export function readEnvFile(file: string = ENV_FILE): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  const content = readFileSync(file, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), unquote(trimmed.slice(eq + 1).trim()));
  }
  return map;
}

/** Strips one pair of matching surrounding quotes: a path with a space has to be
 *  quoted for a shell `source` of the same file. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) return value.slice(1, -1);
  }
  return value;
}

/** Process env first, then .env.local. Empty values count as unset. */
export function envSetting(key: string, file: string = ENV_FILE): string | undefined {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readEnvFile(file).get(key)?.trim();
  return fromFile || undefined;
}
