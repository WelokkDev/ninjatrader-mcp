import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENV_FILE = path.join(__dirname, "..", "..", ".env.local");
const TOKEN_KEY = "NT_BRIDGE_TOKEN";

function readEnvFile(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return map;
  const content = readFileSync(ENV_FILE, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

export function loadOrCreateToken(): { token: string; path: string; created: boolean } {
  const fromEnv = process.env[TOKEN_KEY];
  if (fromEnv && fromEnv.length > 0) {
    return { token: fromEnv, path: "(process env)", created: false };
  }

  const fileEnv = readEnvFile();
  const existing = fileEnv.get(TOKEN_KEY);
  if (existing && existing.length > 0) {
    return { token: existing, path: ENV_FILE, created: false };
  }

  const token = randomBytes(32).toString("hex");
  const line = `${TOKEN_KEY}=${token}\n`;
  if (existsSync(ENV_FILE)) {
    appendFileSync(ENV_FILE, line);
  } else {
    writeFileSync(ENV_FILE, line, { mode: 0o600 });
  }
  return { token, path: ENV_FILE, created: true };
}
