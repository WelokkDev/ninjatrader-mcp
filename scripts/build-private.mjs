#!/usr/bin/env node
// Build YOUR private MCP bin (src/private/ -> build/private/index.js).
//   Run:  npm run build:private
//   Or:   npm run typecheck:private   (--typecheck: same project, no emit)
// Generic on purpose: it knows nothing about what's inside src/private/ beyond
// three optional files. With --optional (used by the public `npm run build`
// chain) it exits 0 silently when src/private/ is absent, so a fresh clone
// builds public-only while a private-module checkout keeps build/ and
// build/private/ in sync from one command.
//
// Steps:
//   1. src/private/scripts/prebuild.mjs   (optional hook, runs first)
//   2. tsc -p <project>                   (compiles src/ INCLUDING src/private/)
//   3. src/private/scripts/copy-assets.mjs (optional hook, runs last)
//
// <project> is tsconfig.private.json unless src/private/tsconfig.json exists,
// in which case that one wins — see resolution below.

import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const privateDir = join(root, "src", "private");
const optional = process.argv.includes("--optional");
const typecheckOnly = process.argv.includes("--typecheck");

if (!existsSync(privateDir)) {
  if (optional) process.exit(0);
  console.error(
    "No src/private/ found. Scaffold yours first:  npm run init-private",
  );
  process.exit(1);
}

// Optional file #3: your own tsconfig. Without one, the public
// tsconfig.private.json compiles every .ts under src/ including src/private/.
// Drop a tsconfig.json in src/private/ and it wins instead — that is where a
// private module declares compiler settings the public repo has no business
// knowing, such as excluding a nested app directory that builds under its own
// toolchain. Extend the public root config from it so the two agree on target,
// module, rootDir and outDir:
//
//   { "extends": "../../tsconfig.json", "exclude": ["**/node_modules", "…"] }
//
// Paths inside it resolve relative to src/private/, not to the repo root.
const project = existsSync(join(privateDir, "tsconfig.json"))
  ? "src/private/tsconfig.json"
  : "tsconfig.private.json";

// Resolve tsc from the repo's own devDependencies even when invoked directly
// (node scripts/build-private.mjs) rather than through npm-run-script.
const env = {
  ...process.env,
  PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
};

// Only ever called with the static command strings below — the sole variable,
// `project`, is one of the two literal paths above, never user input (execSync
// goes through the shell, which also resolves the tsc shim on Windows).
const run = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", env });
};

// Runs for a typecheck too: this hook generates compiler inputs, so skipping it
// would typecheck a tree the build never actually compiles.
const prebuild = join(privateDir, "scripts", "prebuild.mjs");
if (existsSync(prebuild)) run("node src/private/scripts/prebuild.mjs");

run(`tsc -p ${project}${typecheckOnly ? " --noEmit" : ""}`);

// Emit-time only — nothing to copy alongside a build that produced no output.
if (typecheckOnly) {
  console.log("Typecheck clean.");
  process.exit(0);
}

const postbuild = join(privateDir, "scripts", "copy-assets.mjs");
if (existsSync(postbuild)) run("node src/private/scripts/copy-assets.mjs");

console.log("Done. Point your MCP client at build/private/index.js");
