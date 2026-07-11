import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lab } from "../lab-instance.js";
import type { ExperimentSpec, Prediction } from "../lab/types.js";

// start_experiment — fire-and-forget launch of a backtest experiment. Returns an
// experimentId + a launch-time ETA immediately; the run happens in a detached
// process. Poll experiment_status / experiment_result. A real run is ~100 min,
// so this NEVER runs the backtest inside the tool call.

type ToolResult = { content: Array<{ type: "text"; text: string }> };
const ok = (payload: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
});

export function registerStartExperiment(server: McpServer): void {
  server.tool(
    "start_experiment",
    "Launch a backtest experiment asynchronously. Returns {experimentId, etaSecs, etaText, queued} instantly — the run executes in a detached process. Poll experiment_status for progress and experiment_result for the token-tiny verdict. Pass a 'prediction' to pre-register the expected effect (anti-self-deception).",
    {
      symbol: z.string().describe("Instrument, e.g. NQ."),
      startDay: z.string().describe('Range start, "YYYY-MM-DD".'),
      endDay: z.string().describe('Range end, "YYYY-MM-DD".'),
      engine: z.enum(["observe", "replay"]).optional().describe("Engine mode (default observe)."),
      modes: z.array(z.string()).optional().describe("Management modes, e.g. [fixed,trailing,constrained]."),
      strategy: z.string().optional().describe("Strategy name (default: engine default)."),
      smaPreset: z.string().optional().describe("SMA preset name."),
      lookbackDays: z.number().int().positive().optional().describe("Zone-detection lookback days."),
      configOverrides: z.record(z.string(), z.unknown()).optional().describe("Deep-merged config overrides (the config-sweep knob)."),
      lean: z.boolean().optional().describe("Skip the giant decisions.jsonl (recommended for sweeps)."),
      expBranch: z.string().optional().describe("Private-repo branch this variant's engine code lives on."),
      label: z.string().optional().describe("Human label for the experiment."),
      prediction: z
        .object({
          hypothesis: z.string(),
          gateUnderTest: z.string().optional(),
          predictedTradeBand: z.array(z.number()).length(2).optional(),
        })
        .optional()
        .describe("Pre-registered prediction (recorded before the run)."),
    },
    async (args): Promise<ToolResult> => {
      const prediction: Prediction | undefined = args.prediction
        ? {
            hypothesis: args.prediction.hypothesis,
            gateUnderTest: args.prediction.gateUnderTest,
            predictedTradeBand: args.prediction.predictedTradeBand as [number, number] | undefined,
          }
        : undefined;
      const spec: ExperimentSpec = {
        symbol: args.symbol,
        startDay: args.startDay,
        endDay: args.endDay,
        engine: args.engine,
        modes: args.modes,
        strategy: args.strategy,
        smaPreset: args.smaPreset,
        lookbackDays: args.lookbackDays,
        configOverrides: args.configOverrides,
        lean: args.lean,
        expBranch: args.expBranch,
        label: args.label,
        prediction,
      };
      const res = await lab.start(spec);
      return ok(res);
    },
  );
}
