import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { SUPPORTED_SYMBOLS } from "../core/constants.js";
import {
  DEFAULT_STRATEGY,
  DEFAULT_SMA_PRESET,
  DEFAULT_LOOKBACK_DAYS,
} from "../private/decision/playing-field-orchestrator.js";
import { composeBacktest } from "../private/decision/backtest-walker.js";

// run_backtest — public MCP registration + a thin validate→delegate→serialize handler. 
// Walks the decision engine over [rangeStart, rangeEnd] of 5m closes, opens a trade on each 'yes', 
// and replays the exit under each requested management mode (fixed / trailing / constrained) over the SAME entry set, 
// so the modes are comparable apples-to-apples. Writes trades + every decision (the stall funnel) 
// to the ledger and returns a per-mode summary. The walk itself lives behind composeBacktest in src/private/decision. 
// Read-through over the 5m cache — call get_candles first to populate the range.

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

const MODES = ["fixed", "trailing", "constrained"] as const;

export interface RunBacktestArgs {
  symbol: string;
  rangeStart: number;
  rangeEnd: number;
  strategyName?: string;
  smaPreset?: string;
  lookbackDays?: number;
  managementModes?: Array<(typeof MODES)[number]>;
  configOverrides?: unknown;
}

export interface RunBacktestDeps {
  db: Database;
}

export function createRunBacktestHandler(deps: RunBacktestDeps) {
  return async ({
    symbol,
    rangeStart,
    rangeEnd,
    strategyName = DEFAULT_STRATEGY,
    smaPreset = DEFAULT_SMA_PRESET,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    managementModes = [...MODES],
    configOverrides,
  }: RunBacktestArgs): Promise<ToolResult> => {
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return err(
        `Unsupported symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(", ")}`,
      );
    }
    if (!Number.isFinite(rangeStart) || rangeStart <= 0) {
      return err("rangeStart must be a positive unix-seconds timestamp.");
    }
    if (!Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
      return err("rangeEnd must be a unix-seconds timestamp greater than rangeStart.");
    }
    if (managementModes.length === 0) {
      return err(`managementModes must name at least one of: ${MODES.join(", ")}.`);
    }

    const result = composeBacktest({
      db: deps.db,
      symbol,
      rangeStart,
      rangeEnd,
      strategyName,
      smaPreset,
      lookbackDays,
      managementModes,
      configOverrides,
    });
    if ("error" in result) return err(String(result.error));
    if (result.barsEvaluated === 0) {
      return ok({
        ...result,
        note: `No 5m bars evaluated in the range. Call get_candles for ${symbol} over [${rangeStart}, ${rangeEnd}] first.`,
      });
    }
    return ok(result);
  };
}

export function registerRunBacktest(server: McpServer): void {
  const handler = createRunBacktestHandler({ db: defaultDb });

  server.tool(
    "run_backtest",
    "Walk the decision engine over a [rangeStart, rangeEnd] window of 5m closes, open a trade on each 'yes' (entry = next-bar open), and simulate the exit under each requested management mode (fixed / trailing / constrained) over the SAME entry set. Writes trades + every decision (the stall funnel) to the ledger and returns a per-mode summary (nTrades, winRate, sumR, avgR/expectancy, avgMfe, ambiguousExitTrades). Read-through over the 5m cache — call get_candles first.",
    {
      symbol: z
        .string()
        .describe("Futures symbol (ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC)"),
      rangeStart: z
        .number()
        .describe("Backtest window start as a unix-seconds timestamp."),
      rangeEnd: z
        .number()
        .describe("Backtest window end as a unix-seconds timestamp (> rangeStart)."),
      strategyName: z
        .string()
        .optional()
        .default(DEFAULT_STRATEGY)
        .describe(`Strategy config name (without .json). Defaults to "${DEFAULT_STRATEGY}".`),
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
          `Days of 5m history loaded before each asOf for HTF aggregation. Default ${DEFAULT_LOOKBACK_DAYS}.`,
        ),
      managementModes: z
        .array(z.enum(MODES))
        .optional()
        .default([...MODES])
        .describe(
          "Exit-management policies to compare over the same entries. Default: all three (fixed, trailing, constrained).",
        ),
      configOverrides: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Partial overrides deep-merged onto the flat strategy config before each decision (e.g. { "trade": { "minRR": 2 } } to loosen the gate for a first ≥20-trade sanity run).',
        ),
    },
    handler,
  );
}
