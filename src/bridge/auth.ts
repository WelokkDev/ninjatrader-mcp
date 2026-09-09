import { randomBytes } from "crypto";
import { writeFileSync, existsSync, appendFileSync } from "fs";
import { ENV_FILE, readEnvFile } from "../core/env-local.js";

const TOKEN_KEY = "NT_BRIDGE_TOKEN";

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
