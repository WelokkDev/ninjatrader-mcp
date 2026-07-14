#!/usr/bin/env node
// MCP entrypoint the committed .mcp.json points at. Boots the private bin when
// a private module has been built (build/private/index.js), otherwise the
// public bin — so a fresh clone works out of the box and a private-module
// checkout gets its full surface, with no per-user .mcp.json edits.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const privateBin = join(root, "build", "private", "index.js");
const publicBin = join(root, "build", "index.js");

await import(pathToFileURL(existsSync(privateBin) ? privateBin : publicBin).href);
