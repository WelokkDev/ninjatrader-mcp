import { getInstrumentConfig } from "../core/sessions/registry.js";
import type { DetectedGap } from "./recorder.js";
import type { LiveTimeframe } from "./registry.js";

/**
 * Max heal reach per raw TF — shallower for finer TFs since seconds history
 * is shallow provider-side (1s tightest: a 6h reach would mean a ~20k-bar
 * refetch on one gap). Older gaps belong to get_candles' day-level backfill.
 */
export const HEAL_MAX_WINDOW_SECS: Record<LiveTimeframe, number> = {
  "1s": 30 * 60,
  "5s": 2 * 3600,
  "15s": 6 * 3600,
  "5m": 3 * 86400,
  "15m": 3 * 86400,
};

export const TF_SECS: Record<LiveTimeframe, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "5m": 300,
  "15m": 900,
};

/**
 * Minimum LONGEST CONTIGUOUS RUN of missing buckets (seconds) before a gap
 * triggers a heal (see longestMissingRunSecs). 0 = always heal.
 *
 * Deliberately BELOW the validator's own "still ok" ceilings
 * (SPARSE_TOLERANCE.maxGapSeconds) — healing a lull costs one request,
 * missing an outage costs silent data loss. Sub-15s values are unverified
 * estimates; retune via `npm run audit-bars` once real data is cached.
 */
export const GAP_MIN_SPAN_SECS: Record<LiveTimeframe, number> = {
  "1s": 180,
  "5s": 120,
  "15s": 0,
  "5m": 0,
  "15m": 0,
};

const HEAL_REQUEST_TIMEOUT_MS = 30_000;

export interface HealDeps {
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  isConnected: () => boolean;
  nowUnix?: () => number;
}

export interface HealResult {
  requested: boolean;
  reason?: string;
}

/**
 * Re-fetches missing bars via request_candles; the response lands through
 * the normal ingest handler. One heal in flight per stream — overlapping
 * triggers are harmless (ingest dedupes, the guard drops the second).
 */
export class GapHealer {
  private readonly deps: HealDeps;
  private readonly inFlight = new Set<string>();

  constructor(deps: HealDeps) {
    this.deps = deps;
  }

  healsInFlight(): number {
    return this.inFlight.size;
  }

  async heal(gap: DetectedGap): Promise<HealResult> {
    if (!this.deps.isConnected()) {
      return { requested: false, reason: "bridge not connected" };
    }

    let template: string;
    try {
      template = getInstrumentConfig(gap.symbol).session.name;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { requested: false, reason: m };
    }

    const now = this.deps.nowUnix
      ? this.deps.nowUnix()
      : Math.floor(Date.now() / 1000);
    const tfSecs = TF_SECS[gap.timeframe];
    const windowEdge = now - HEAL_MAX_WINDOW_SECS[gap.timeframe];
    if (gap.toTs < windowEdge) {
      return {
        requested: false,
        reason: `gap ${gap.symbol} ${gap.timeframe} [${gap.fromTs}..${gap.toTs}] exceeds heal window — run get_candles over that range for a day-level backfill`,
      };
    }

    const key = `${gap.symbol}:${gap.timeframe}`;
    if (this.inFlight.has(key)) {
      return { requested: false, reason: `heal already in flight for ${key}` };
    }
    this.inFlight.add(key);

    // One-bar overlap margins — free under INSERT OR REPLACE, edge-proof.
    const from = Math.max(gap.fromTs - tfSecs, windowEdge);
    const to = gap.toTs + tfSecs;

    try {
      await this.deps.request(
        "request_candles",
        {
          symbol: gap.symbol,
          timeframe: gap.timeframe,
          from,
          to,
          tradingHoursTemplate: template,
        },
        HEAL_REQUEST_TIMEOUT_MS,
      );
      console.error(
        `[live-heal] requested ${key} [${from}..${to}] (${Math.round((to - from) / tfSecs)} bar-widths)`,
      );
      return { requested: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[live-heal] ${key} failed: ${m}`);
      return { requested: false, reason: m };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
