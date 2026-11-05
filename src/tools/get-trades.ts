import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ledger as defaultLedger, type Ledger, type Trade } from "../db/ledger.js";
import { ingestTrades } from "../trade-source/ingest.js";
import { NinjaTraderSource } from "../trade-source/ninjatrader.js";
import { envSetting, ENV_FILE } from "../core/env-local.js";
import type { TradeSource } from "../trade-source/types.js";
import { errorResult, jsonResult, type ToolResult } from "./result.js";

// get_trades + sync_trades — thin fetch-or-read shells over the ledger + NinjaTrader source.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface NinjaTraderConfig {
  dbPath: string;
  account?: string;
}

/**
 * Resolves NT8's trade database location and returns { dbPath, account? }.
 *
 * Resolution (in priority order):
 *   1. NT_TRADES_DB_PATH — process env, else .env.local. Optionally paired
 *      with NT_TRADES_ACCOUNT. No JSON file needed at all.
 *   2. NT_TRADES_CONFIG env var (absolute path to a custom config file)
 *   3. <repo-root>/ninjatrader.config.json (default)
 *
 *
 * This function is LAZY — only called inside the ingest branch of the handlers,
 * never at module load or registration time. Throws a descriptive Error if the
 * file is missing, malformed JSON, or lacks the required `dbPath` field.
 *
 * `envFile` exists so tests can isolate from the developer's own `.env.local`;
 * production callers use the default.
 */
export function loadNinjaTraderConfig(envFile: string = ENV_FILE): NinjaTraderConfig {
  const dbPathFromEnv = envSetting("NT_TRADES_DB_PATH", envFile);
  if (dbPathFromEnv) {
    const account = envSetting("NT_TRADES_ACCOUNT", envFile);
    return account ? { dbPath: dbPathFromEnv, account } : { dbPath: dbPathFromEnv };
  }

  const configPath = process.env.NT_TRADES_CONFIG
    ? path.resolve(process.env.NT_TRADES_CONFIG)
    : path.join(__dirname, "..", "..", "ninjatrader.config.json");

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `loadNinjaTraderConfig: cannot read "${configPath}", and NT_TRADES_DB_PATH is not set. ` +
        `Either set NT_TRADES_DB_PATH=<path to NinjaTrader.sqlite> in .env.local, ` +
        `or create the file with shape { "dbPath": "<path to NinjaTrader.sqlite>", "account"?: "<account name>" }.`,
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

const mismatchWarning = (n: number) =>
  `${n} stored trade(s) differ from what NT8 reports now and were left untouched`;

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
    account,
  }: {
    from: number;
    to: number;
    sync?: boolean;
    account?: string;
  }): Promise<ToolResult> => {
    const inRange = (t: Trade) => t.entryTime >= from && t.entryTime <= to;
    const matches = (t: Trade) => !account || t.account === account;

    let all = ledger.listTrades().filter(inRange);
    let trades = all.filter(matches);
    // Rows imported before accounts were stored; an import fills them in.
    const unattributed = () => (account ? all.filter((t) => t.account === null).length : 0);
    let mismatched = 0;

    if (trades.length === 0 || sync === true || unattributed() > 0) {
      try {
        const source = resolveSource(account || undefined);
        ({ mismatched } = await ingestTrades(source, ledger, { from, to }));
        all = ledger.listTrades().filter(inRange);
        trades = all.filter(matches);
      } catch (err) {
        if (trades.length === 0) {
          // No pre-existing rows and ingest failed — surface the error.
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({
          count: trades.length,
          trades,
          warning: `ingest failed: ${msg}; returning existing rows`,
        });
      }
    }

    const warnings: string[] = [];
    if (mismatched > 0) warnings.push(mismatchWarning(mismatched));
    if (unattributed() > 0) {
      warnings.push(`${unattributed()} trade(s) in range have no recorded account and were left out`);
    }
    if (account && trades.length === 0) {
      const names = [...new Set(all.flatMap((t) => (t.account ? [t.account] : [])))];
      warnings.push(`no trades for account "${account}"; accounts in range: ${names.join(", ") || "none"}`);
    }
    return jsonResult({
      count: trades.length,
      trades,
      ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    });
  };
}

export function registerGetTrades(server: McpServer): void {
  const handler = createGetTradesHandler();

  server.tool(
    "get_trades",
    "Returns imported trades in [from,to], ingesting on demand if the range is empty or sync is true: { count, trades }. Per trade: account, direction, entry/exit time and avg price, quantity (peak position), filledQuantity, commission.",
    {
      from: z.number().describe("range start, unix seconds"),
      to: z.number().describe("range end, unix seconds"),
      sync: z
        .boolean()
        .optional()
        .describe("force re-ingest even if rows already exist for the range"),
      account: z.string().optional().describe("omit for all accounts"),
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
      const result = await ingestTrades(source, ledger, { from, to });
      return jsonResult(
        result.mismatched > 0 ? { ...result, warning: mismatchWarning(result.mismatched) } : result,
      );
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

export function registerSyncTrades(server: McpServer): void {
  const handler = createSyncTradesHandler();

  server.tool(
    "sync_trades",
    "Explicit refresh: ingests NinjaTrader trades for the range; returns { fetched, inserted, filled, mismatched } (filled: older rows completed).",
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
