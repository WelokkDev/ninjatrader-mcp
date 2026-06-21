import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// Per-bar cost was measured to swing ~120× run-to-run from machine contention,
// so a single mean ETA lies. We keep a rolling sample of ms/unit keyed by the
// caller (typically `${runner}:${engineMode}`), report the MEDIAN, and expose a
// wide band (p50…p90) so the UI can say "≈Xm, could be Ym" honestly.

export interface EtaEstimate {
  /** Point estimate (seconds) from the median ms/unit. null if no basis at all. */
  secs: number | null;
  /** Honest range [p50-based, p90-based] seconds, when samples exist. */
  bandSecs?: [number, number];
  p50MsPerUnit: number | null;
  samples: number;
  /** True when the estimate came from the cold-start fallback, not real data. */
  cold: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

export interface EtaCalibratorOptions {
  /** Max samples retained per key (rolling window). */
  capacity?: number;
  /** Used when a key has zero samples so ETA is never NaN. */
  fallbackMsPerUnit?: number;
}

export class EtaCalibrator {
  private readonly samples = new Map<string, number[]>();
  private readonly capacity: number;
  private readonly fallback: number;

  constructor(opts: EtaCalibratorOptions = {}) {
    this.capacity = opts.capacity ?? 50;
    this.fallback = opts.fallbackMsPerUnit ?? 400;
  }

  /** Feed a completed run's measured cost. */
  record(key: string, msPerUnit: number): void {
    if (!Number.isFinite(msPerUnit) || msPerUnit <= 0) return;
    const arr = this.samples.get(key) ?? [];
    arr.push(msPerUnit);
    while (arr.length > this.capacity) arr.shift();
    this.samples.set(key, arr);
  }

  medianMsPerUnit(key: string): number | null {
    const arr = this.samples.get(key);
    if (!arr || arr.length === 0) return null;
    return percentile([...arr].sort((a, b) => a - b), 50);
  }

  estimate(key: string, unitsRemaining: number): EtaEstimate {
    const arr = this.samples.get(key);
    const units = Math.max(0, unitsRemaining);
    if (!arr || arr.length === 0) {
      return {
        secs: (this.fallback * units) / 1000,
        p50MsPerUnit: null,
        samples: 0,
        cold: true,
      };
    }
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p90 = percentile(sorted, 90);
    return {
      secs: (p50 * units) / 1000,
      bandSecs: [(p50 * units) / 1000, (p90 * units) / 1000],
      p50MsPerUnit: p50,
      samples: arr.length,
      cold: false,
    };
  }

  toJSON(): Record<string, number[]> {
    return Object.fromEntries(this.samples);
  }

  loadJSON(data: Record<string, number[]>): void {
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) this.samples.set(k, v.slice(-this.capacity));
    }
  }

  saveFile(filePath: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(this.toJSON(), null, 2));
  }

  static fromFile(filePath: string, opts?: EtaCalibratorOptions): EtaCalibrator {
    const cal = new EtaCalibrator(opts);
    if (existsSync(filePath)) {
      try {
        cal.loadJSON(JSON.parse(readFileSync(filePath, "utf8")));
      } catch {
        /* corrupt calibration file → start cold */
      }
    }
    return cal;
  }
}
