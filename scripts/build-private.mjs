#!/usr/bin/env node
// Build YOUR private MCP bin (src/private/ -> build/private/index.js).
//   Run:  npm run build:private
// Generic on purpose: it knows nothing about what's inside src/private/ beyond
// two optional hook files. With --optional (used by the public `npm run build`
// chain) it exits 0 silently when src/private/ is absent, so a fresh clone
// builds public-only while a private-module checkout keeps build/ and
// build/private/ in sync from one command.
//
// Steps:
//   1. src/private/scripts/prebuild.mjs   (optional hook, runs first)
//   2. tsc -p tsconfig.private.json       (compiles src/ INCLUDING src/private/)
//   3. src/private/scripts/copy-assets.mjs (optional hook, runs last)

import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const privateDir = join(root, "src", "private");
const optional = process.argv.includes("--optional");

if (!existsSync(privateDir)) {
  if (optional) process.exit(0);
  console.error(
    "No src/private/ found. Scaffold yours first:  npm run init-private",
  );
  process.exit(1);
}

// Resolve tsc from the repo's own devDependencies even when invoked directly
// (node scripts/build-private.mjs) rather than through npm-run-script.
const env = {
  ...process.env,
  PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
};

// Only ever called with the static command strings below — never with user
// input (execSync goes through the shell, which also resolves the tsc shim on
// Windows).
const run = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", env });
};

const prebuild = join(privateDir, "scripts", "prebuild.mjs");
if (existsSync(prebuild)) run("node src/private/scripts/prebuild.mjs");

run("tsc -p tsconfig.private.json");

const postbuild = join(privateDir, "scripts", "copy-assets.mjs");
if (existsSync(postbuild)) run("node src/private/scripts/copy-assets.mjs");

console.log("Done. Point your MCP client at build/private/index.js");
