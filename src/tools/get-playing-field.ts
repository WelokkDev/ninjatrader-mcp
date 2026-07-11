import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import {
  composePlayingField,
  DEFAULT_STRATEGY,
  DEFAULT_SMA_PRESET,
  DEFAULT_LOOKBACK_DAYS,
} from "../private/decision/playing-field-orchestrator.js";

// get_playing_field — public MCP registration + a thin validate→delegate→serialize handler.
// Everything strategy-shaped (config assembly, frozen MTF view, daily-ATR derivation, the
// scan pipeline and its result shape) lives behind composePlayingField in src/private/decision,
// so the public layer names nothing proprietary.
// Read-only over the 5m cache, call get_candles first.

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export interface GetPlayingFieldArgs {
  symbol: string;
  asOf: number;
  strategyName?: string;
  smaPreset?: string;
  lookbackDays?: number;
}

export interface GetPlayingFieldDeps {
  db: Database;
}

export function createGetPlayingFieldHandler(deps: GetPlayingFieldDeps) {
  return async ({
    symbol,
    asOf,
    strategyName = DEFAULT_STRATEGY,
    smaPreset = DEFAULT_SMA_PRESET,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
  }: GetPlayingFieldArgs): Promise<ToolResult> => {
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return err(
        `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
      );
    }
    if (!Number.isFinite(asOf) || asOf <= 0) {
      return err("asOf must be a positive unix-seconds timestamp.");
    }

    const result = composePlayingField({
      db: deps.db,
      symbol,
      asOf,
      strategyName,
      smaPreset,
      lookbackDays,
    });
    return "error" in result ? err(result.error) : ok(result);
  };
}

export function registerGetPlayingField(server: McpServer): void {
  const handler = createGetPlayingFieldHandler({ db: defaultDb });

  server.tool(
    "get_playing_field",
    "Assemble the multi-timeframe trade context at a single decision instant: trend direction, the nearest qualified target/source zones, obstacles in the path to target, and risk/reward reachability. Read-only over the 5m cache — call get_candles first to populate it.",
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
