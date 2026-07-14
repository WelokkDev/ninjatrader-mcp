# Build your own private trading module

> This walkthrough is addressed to the AI agent (Claude or otherwise) helping a
> user extend this repo. If you're reading it yourself: it works the same, just
> type the commands.

You are helping the user build their **private trading module** on top of the
public `ninjatrader-mcp` substrate. Follow the steps in order; each one is
verifiable before moving on.

## 1. The model

- `src/private/` is the user's own folder. It is **gitignored** — nothing in it
  ever reaches the public repo, and the public code never imports from it. The
  dependency is strictly one-way: private imports public.
- Their private module is its own MCP server bin (`src/private/index.ts`) that
  boots the **whole public tool surface with one call** and then registers
  their own tools on top.
- Run **exactly one server process**. Whichever bin the MCP client points at
  owns the NinjaTrader bridge (WebSocket port) and the candle cache — a second
  process would find the port taken and run bridge-disabled.
- Public compile stays private-free: `npm run typecheck` and the `tsc` step of
  `npm run build` never compile `src/private/`. When a private module exists,
  `npm run build` finishes by rebuilding it (same guard as
  `npm run build:private`) so the two bundles never drift, and `npm test` DOES
  run `src/private/tests/` when present. The private counterparts are
  `npm run build:private` and `npm run typecheck:private`.

## 2. Scaffold

```
npm run init-private
```

Idempotent; never overwrites existing files. It creates:

- `src/private/index.ts` — the user's MCP server bin. It calls
  `registerGenericTools(server)` (every public tool, one line — it stays
  current automatically as the public surface grows) and then registers their
  tools, one line each.
- `src/private/tools/my-tool.ts` — a minimal example tool to copy from.

Build and verify before customizing anything:

```
npm run build:private
```

This compiles everything including `src/private/` and emits the bin at
`build/private/index.js`.

## 3. First custom tool

Create `src/private/tools/my-first-scan.ts` — a complete working tool that
reads the local candle cache (fill it with `get_candles` first) and returns
the N-day high/low:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import db from "../../db/connection.js";

// Reads candles already in the SQLite cache (candles.db). Timestamps are unix
// SECONDS. Companion to get_candles: get_candles fills the cache, this reads it.

export function registerMyFirstScan(server: McpServer): void {
  server.tool(
    "my_first_scan",
    "Highest high / lowest low over the last N days of cached 5m candles.",
    {
      symbol: z.string().min(1).describe("Instrument symbol, e.g. MNQ"),
      days: z.number().int().positive().default(5).describe("Lookback days"),
    },
    async ({ symbol, days }: { symbol: string; days: number }) => {
      const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
      const row = db
        .prepare(
          `SELECT MAX(high) AS hi, MIN(low) AS lo, COUNT(*) AS bars
             FROM candles
            WHERE symbol = ? AND timeframe = '5m' AND timestamp > ?`,
        )
        .get(symbol, cutoff) as { hi: number | null; lo: number | null; bars: number };
      const payload =
        row.bars === 0
          ? { symbol, days, error: "no cached 5m candles in range — run get_candles first" }
          : { symbol, days, high: row.hi, low: row.lo, bars: row.bars };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );
}
```

Wire it into `src/private/index.ts` (two lines):

```ts
import { registerMyFirstScan } from "./tools/my-first-scan.js";
// ... after registerGenericTools(server):
registerMyFirstScan(server);
```

Rebuild: `npm run build:private`.

## 4. Point the MCP client at the private bin

The repo's `.mcp.json` already points at `build/private/index.js`, so after
`npm run build:private` a client restart is all it takes. (To run the plain
public server instead — no private module — point it at `build/index.js`.)

Restart the MCP client and verify: the tool list should show every public tool
**plus** `my_tool` and `my_first_scan`. Call `my_first_scan` with a symbol you
have cached candles for and check the JSON comes back.

## 5. Where to go deeper

- **Replace a public tool**: the MCP SDK rejects duplicate tool names, so
  skip the stock registration and then register your own under the same name:
  `registerGenericTools(server, { except: ["get_candles"] })` followed by your
  `registerMyGetCandles(server)`. No fork. (The three `prefetch_*` tools share
  one registration — excluding any of them excludes all three.)
- **Look-ahead-safe logic**: when a tool reasons "as of" a historical moment,
  query with `timestamp <= asOf` cutoffs so nothing from the future leaks into
  the decision. Build frozen views once, pass them down.
- **The ledger**: `trades` and `trade_decisions` tables (see `src/db/schema.ts`
  and the `list_trades` / `list_decisions` tools) — write your decisions there
  and they become queryable history.
- **Session math**: never compute `days × bars/day` by hand — use the helpers
  in `src/core/sessions/` (holiday calendar, maintenance breaks, session-day
  ranges), same as `resolve_session_days` does.
- **Experiments (needs an engine)**: once the user has their own backtest
  runner, bind it to a `Lab` (see `src/lab/` — the generic orchestrator: store,
  ETA, observability, crash recovery) and add
  `registerExperimentTools(server, lab)` to their bin to get
  `start_experiment` / `experiment_status` / `experiment_result` /
  `list_experiments` / `diff_experiments` over their engine.

## Etiquette

- Never `git add -f src/private/`, never include it in a PR to the public repo.
- To version the private module, `git init` **inside** `src/private/` (nested
  repo with its own private remote).
- Public code must never import from `src/private/` — if a public file needs
  private logic, invert it: put a generic seam in public and the implementation
  in private.
