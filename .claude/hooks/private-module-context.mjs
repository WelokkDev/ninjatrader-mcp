#!/usr/bin/env node
// SessionStart hook: when this clone has no src/private/ module, inject a
// pointer to the private-module walkthrough into the agent's context.
// Prints nothing (injects nothing) when src/private/ exists.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

if (!existsSync(join(root, "src", "private"))) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "This clone has no src/private/ module — the repo currently runs the " +
          "public substrate only (generic tools, no decision engine). If the " +
          "user wants to add their own or private tools, follow BUILD-YOUR-OWN.md " +
          "at the repo root: scaffold with `npm run init-private`, build with " +
          "`npm run build:private`, and point the MCP client at " +
          "build/private/index.js. Never put user-specific logic in the public " +
          "src/ tree — it belongs in src/private/.",
      },
    }),
  );
}
