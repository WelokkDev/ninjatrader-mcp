import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ledger as defaultLedger, type Ledger } from "../db/ledger.js";
import { ingestTrades } from "../trade-source/ingest.js";
import { NinjaTraderSource } from "../trade-source/ninjatrader.js";
import type { TradeSource } from "../trade-source/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// get_trades + sync_trades — thin fetch-or-read shells over the ledger + NinjaTrader source.
// Both tools follow the same pattern as list-trades.ts (createXHandler factory + registerX(server) calling server.tool).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface NinjaTraderConfig {
  dbPath: string;
  account?: string;
}

/**
 * Reads ninjatrader.config.json and returns { dbPath, account? }.
 *
 * Path resolution (in priority order):
 *   1. NT_TRADES_CONFIG env var (absolute path to a custom config file)
 *   2. <repo-root>/ninjatrader.config.json (default)
 *
 * This function is LAZY — only called inside the ingest branch of the handlers,
 * never at module load or registration time. Throws a descriptive Error if the
 * file is missing, malformed JSON, or lacks the required `dbPath` field.
 */
export function loadNinjaTraderConfig(): NinjaTraderConfig {
  const configPath = process.env.NT_TRADES_CONFIG
    ? path.resolve(process.env.NT_TRADES_CONFIG)
    : path.join(__dirname, "..", "..", "ninjatrader.config.json");

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `loadNinjaTraderConfig: cannot read "${configPath}". ` +
        `Create the file with shape { "dbPath": "<path to NinjaTrader.sqlite>", "account"?: "<account name>" }.`,
    );
  }

  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error(`loadNinjaTraderConfig: "${configPath}" contains invalid JSON.`);
  }

  if (
    !cfg ||
    typeof cfg !== "object" ||
    !("dbPath" in cfg) ||
    typeof (cfg as NinjaTraderConfig).dbPath !== "string"
  ) {
    throw new Error(
      `loadNinjaTraderConfig: "${configPath}" must have shape` +
        ` { "dbPath": string, "account"?: string }. Got: ${raw.slice(0, 200)}`,
    );
  }

  return cfg as NinjaTraderConfig;
}

function defaultResolveSource(account?: string): TradeSource {
  const cfg = loadNinjaTraderConfig();
  return new NinjaTraderSource({ dbPath: cfg.dbPath, account: account ?? cfg.account });
}

export interface TradeToolDeps {
  /** Defaults to the app-wide ledger singleton. Tests inject an in-memory instance. */
  ledger?: Ledger;
  /**
   * Defaults to defaultResolveSource (reads config + constructs NinjaTraderSource).
   * Tests inject a fake TradeSource to avoid any file-system access.
   */
  resolveSource?: (account?: string) => TradeSource;
}

export function createGetTradesHandler(deps?: TradeToolDeps) {
  const ledger = deps?.ledger ?? defaultLedger;
  const resolveSource = deps?.resolveSource ?? defaultResolveSource;

  return async ({
    from,
    to,
    sync,
  }: {
    from: number;
    to: number;
    sync?: boolean;
  }): Promise<ToolResult> => {
    const inRange = (t: { entryTime: number }) =>
      t.entryTime >= from && t.entryTime <= to;

    let trades = ledger.listTrades({ mode: "live" }).filter(inRange);

    if (trades.length === 0 || sync === true) {
      try {
        const source = resolveSource();
        await ingestTrades(source, ledger, { from, to });
        trades = ledger.listTrades({ mode: "live" }).filter(inRange);
      } catch (err) {
        if (trades.length === 0) {
          // No pre-existing rows and ingest failed — surface the error.
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({
          count: trades.length,
          trades,
          warning: `sync requested but ingest failed: ${msg}; returning existing rows`,
        });
      }
    }

    return jsonResult({ count: trades.length, trades });
  };
}

export function registerGetTrades(server: McpServer): void {
  const handler = createGetTradesHandler();

  server.tool(
    "get_trades",
    "Returns the user's live/imported trades in [from,to]; ingests on demand if the range is empty or sync is true; returns { count, trades }. mfe carries broker realized P&L when the source provides it; for NinjaTrader-imported trades it is null until a P&L-bearing derivation lands.",
    {
      from: z.number().describe("range start, unix seconds"),
      to: z.number().describe("range end, unix seconds"),
      sync: z
        .boolean()
        .optional()
        .describe("force re-ingest even if rows already exist for the range"),
    },
    handler,
  );
}

export function createSyncTradesHandler(deps?: TradeToolDeps) {
  const ledger = deps?.ledger ?? defaultLedger;
  const resolveSource = deps?.resolveSource ?? defaultResolveSource;

  return async ({
    from,
    to,
    account,
  }: {
    from: number;
    to: number;
    account?: string;
  }): Promise<ToolResult> => {
    try {
      const source = resolveSource(account);
      const { fetched, inserted } = await ingestTrades(source, ledger, { from, to });
      return jsonResult({ fetched, inserted });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

export function registerSyncTrades(server: McpServer): void {
  const handler = createSyncTradesHandler();

  server.tool(
    "sync_trades",
    "Explicit refresh that ingests NinjaTrader trades for the range and returns { fetched, inserted }.",
    {
      from: z.number().describe("range start, unix seconds"),
      to: z.number().describe("range end, unix seconds"),
      account: z
        .string()
        .optional()
        .describe("override the configured NT account"),
    },
    handler,
  );
}
