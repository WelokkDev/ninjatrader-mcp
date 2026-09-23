#!/usr/bin/env node
// MCP entrypoint the committed .mcp.json points at. Picks the private bin when
// a private module has been built (build/private/index.js), otherwise the
// public bin — so a fresh clone works out of the box and a private-module
// checkout gets its full surface, with no per-user .mcp.json edits.
//
// By default this process only proxies to the one hub on this machine, so every
// MCP client shares one bridge, cache and set of live feeds.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = fileURLToPath(import.meta.url);
const root = join(dirname(entry), "..");
const privateBin = join(root, "build", "private", "index.js");
const publicBin = join(root, "build", "index.js");
const bin = existsSync(privateBin) ? privateBin : publicBin;

const args = process.argv.slice(2);
const inProcess =
  args.includes("--hub") || args.includes("--stdio") || process.env.NT_NO_HUB === "1";

if (inProcess) {
  await import(pathToFileURL(bin).href);
} else {
  const { shimMain } = await import(pathToFileURL(join(root, "build", "hub", "shim-main.js")).href);
  await shimMain({ entry, args });
}
