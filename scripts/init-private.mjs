#!/usr/bin/env node
// Idempotent scaffold for the private-tools folder (src/private/).
//   Run:  npm run init-private      (or: node scripts/init-private.mjs)
// Creates a gitignored src/private/ with your own MCP bin + an example tool.
// Safe to re-run: existing files are never overwritten.

import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const privateDir = join(root, "src", "private");
const toolsDir = join(privateDir, "tools");

const INDEX_TS = `#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "../db/connection.js";
import { registerGenericTools, startRuntime, stopRuntime } from "../server.js";
// -- your tools --------------------------------------------------------------
import { registerMyTool } from "./tools/my-tool.js";
// ----------------------------------------------------------------------------

// Your own MCP server. This file is gitignored -- it never reaches the public
// repo. It boots the whole public tool surface via registerGenericTools(), then
// adds your private tools. Point your MCP client at build/private/index.js.

const server = new McpServer({ name: "ninjatrader-private", version: "0.1.0" });

registerGenericTools(server); // every public tool, one line -- current on rebuild

// -- register your own tools below (one line per tool) -----------------------
registerMyTool(server);
// To REPLACE a public tool: the SDK rejects duplicate names, so skip the stock
// registration first — registerGenericTools(server, { except: ["get_candles"] })
// — then register your own under that name.
// ----------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NinjaTrader private MCP server running");
  await startRuntime();
}

const shutdown = async (signal: string) => {
  console.error(\`Received \${signal}, shutting down\`);
  await stopRuntime();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
`;

const MY_TOOL_TS = `import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Example private tool. Everything under src/private/ is gitignored, so this
// file never reaches the public repo. Copy it, rename it, put your own logic in
// the handler, then add a register line in src/private/index.ts.

export function registerMyTool(server: McpServer): void {
  server.tool(
    "my_tool",
    "Example private tool -- replace this description and the handler with your own logic.",
    {
      symbol: z.string().min(1).describe("Instrument symbol, e.g. MNQ"),
    },
    async ({ symbol }: { symbol: string }) => ({
      content: [
        {
          type: "text" as const,
          text: \`Hello from my_tool -- you passed symbol=\${symbol}\`,
        },
      ],
    }),
  );
}
`;

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`  created:          ${relative(root, dir)}/`);
  }
}

function writeIfAbsent(path, content) {
  if (existsSync(path)) {
    console.log(`  exists, skipped:  ${relative(root, path)}`);
    return;
  }
  writeFileSync(path, content);
  console.log(`  created:          ${relative(root, path)}`);
}

console.log("Scaffolding your private tools folder (src/private/)...\n");

ensureDir(privateDir);
ensureDir(toolsDir);
writeIfAbsent(join(privateDir, "index.ts"), INDEX_TS);
writeIfAbsent(join(toolsDir, "my-tool.ts"), MY_TOOL_TS);

// Ensure src/private/ is gitignored (belt-and-suspenders; the committed
// .gitignore already lists it, but a fork may have removed the line).
const giPath = join(root, ".gitignore");
const marker = "src/private/";
const ignoreBlock = `# Private, per-developer tools (never committed to the public repo)\n${marker}\n`;
if (existsSync(giPath)) {
  const gi = readFileSync(giPath, "utf8");
  const present = gi.split(/\r?\n/).some((line) => line.trim() === marker);
  if (!present) {
    appendFileSync(giPath, `\n${ignoreBlock}`);
    console.log(`  updated:          .gitignore (added ${marker})`);
  }
} else {
  // No .gitignore at all (deleted in a fork?) — create one rather than skip:
  // scaffolding private tools without ignore protection risks publishing them.
  writeFileSync(giPath, ignoreBlock);
  console.log(`  created:          .gitignore (with ${marker})`);
}

console.log(`
Done. Next steps:
  1. Build your server:          npm run build:private
  2. Point your MCP client at:   build/private/index.js
  3. Add a tool: drop a file in src/private/tools/ exporting
     register<Name>(server), then add one register line in src/private/index.ts.

Etiquette:
  - src/private/ is gitignored -- it never goes to the public repo, and public
    code never imports from it (one-way dependency).
  - To version your private tools, run \`git init\` INSIDE src/private/ (a nested
    repo with its own remote), or keep them in a separate repo.
  - Never \`git add -f\` src/private/ and never include it in a pull request to
    the public repo.
`);
