import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import {
  composeDecision,
  DEFAULT_STRATEGY,
  DEFAULT_SMA_PRESET,
  DEFAULT_LOOKBACK_DAYS,
} from "../private/decision/playing-field-orchestrator.js";

// scan_for_trade — public MCP registration + a thin validate→delegate→serialize handler. The full decideAtBar (§4.1.9) chain, 
// the config assembly, and the frozen MTF view all live behind composeDecision in src/private/decision; 
// this file names nothing proprietary. Read-only over the 5m cache, call get_candles first.

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export interface ScanForTradeArgs {
  symbol: string;
  asOf: number;
  strategyName?: string;
  smaPreset?: string;
  configOverrides?: unknown;
  lookbackDays?: number;
}

export interface ScanForTradeDeps {
  db: Database;
}

export function createScanForTradeHandler(deps: ScanForTradeDeps) {
  return async ({
    symbol,
    asOf,
    strategyName = DEFAULT_STRATEGY,
    smaPreset = DEFAULT_SMA_PRESET,
    configOverrides,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
  }: ScanForTradeArgs): Promise<ToolResult> => {
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return err(
        `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
      );
    }
    if (!Number.isFinite(asOf) || asOf <= 0) {
      return err("asOf must be a positive unix-seconds timestamp.");
    }

    const result = composeDecision({
      db: deps.db,
      symbol,
      asOf,
      strategyName,
      smaPreset,
      configOverrides,
      lookbackDays,
    });
    return "error" in result ? err(result.error) : ok(result);
  };
}

export function registerScanForTrade(server: McpServer): void {
  const handler = createScanForTradeHandler({ db: defaultDb });

  server.tool(
    "scan_for_trade",
    "Run the full decision chain at a single decision instant and return the structured Decision: verdict ('yes'/'no'), short reason code, the per-step trace, and on a 'yes' the entry (next-bar open), stop, target, RR, and zoneRef. Read-only over the 5m cache — call get_candles first.",
    {
      symbol: z
        .string()
        .describe(
          "Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC)",
        ),
      asOf: z
        .number()
        .describe(
          "Decision instant as a unix-seconds timestamp (a bar-close instant). The frozen MTF view is built at this instant; nothing after it is read.",
        ),
      strategyName: z
        .string()
        .optional()
        .default(DEFAULT_STRATEGY)
        .describe(
          `Strategy config name (without .json). Defaults to "${DEFAULT_STRATEGY}".`,
        ),
      smaPreset: z
        .string()
        .optional()
        .default(DEFAULT_SMA_PRESET)
        .describe(`SMA preset name (without .json). Defaults to "${DEFAULT_SMA_PRESET}".`),
      configOverrides: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Partial overrides deep-merged onto the on-disk strategy config (flat shape, e.g. { "trade": { "minRR": 3 } }) before the decision runs.',
        ),
      lookbackDays: z
        .number()
        .optional()
        .default(DEFAULT_LOOKBACK_DAYS)
        .describe(
          `Days of 5m history to load before asOf for HTF aggregation. Default ${DEFAULT_LOOKBACK_DAYS}.`,
        ),
    },
    handler,
  );
}
