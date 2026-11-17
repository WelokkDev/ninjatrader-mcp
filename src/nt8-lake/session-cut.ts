import { sessionDaysOverlapping } from "../core/sessions/session-day.js";
import type { SessionTemplate } from "../core/sessions/types.js";
import { UNATTESTED, type FetchManifest, type StreamName } from "./source.js";

export const TS_PER_SEC = 10_000_000n;
// Wider than any weekend plus holiday, so the first row always has a cut before it.
const PAD_SECS = 10 * 86_400;

/** Session-day `label` holds `from <= ts < to`; both are template closes in unix seconds. */
export interface Cut {
  label: string;
  from: number;
  to: number;
}

/** No calendar: a calendar edit never moves a row, and the maintenance hour, weekends and
 *  holidays ride at the front of the next session-day. */
export function cutsSpanning(minTs: bigint, maxTs: bigint, template: SessionTemplate): Cut[] {
  const lo = Number(minTs / TS_PER_SEC) - PAD_SECS;
  const hi = Number(maxTs / TS_PER_SEC) + PAD_SECS;
  const days = sessionDaysOverlapping(lo, hi, template);
  const cuts: Cut[] = [];
  for (let i = 1; i < days.length; i++) {
    const cut = { label: days[i].label, from: days[i - 1].endUnix, to: days[i].endUnix };
    if (BigInt(cut.to) * TS_PER_SEC > minTs && BigInt(cut.from) * TS_PER_SEC <= maxTs) cuts.push(cut);
  }
  return cuts;
}

export interface StreamSpan {
  minTs: bigint;
  maxTs: bigint;
}

export type WholeProof =
  | { whole: true; by: "manifest" | "rows" }
  | { whole: false; reason: string };

export function proveWhole(
  cut: Cut,
  manifest: FetchManifest,
  spans: Partial<Record<StreamName, StreamSpan>>,
): WholeProof {
  const from = BigInt(cut.from) * TS_PER_SEC;
  const to = BigInt(cut.to) * TS_PER_SEC;
  if (manifest.window !== UNATTESTED && manifest.fetchedAt !== UNATTESTED) {
    const w = manifest.window;
    if (BigInt(w.from) > from || BigInt(w.to) < to) {
      return { whole: false, reason: `requested window [${w.from}, ${w.to}) does not cover [${from}, ${to})` };
    }
    if (BigInt(manifest.fetchedAt) < to) {
      return { whole: false, reason: `fetched at ${manifest.fetchedAt}, before the session closed at ${to}` };
    }
    return { whole: true, by: "manifest" };
  }
  for (const [stream, span] of Object.entries(spans) as [StreamName, StreamSpan][]) {
    if (span.minTs >= from) return { whole: false, reason: `${stream} has no row before the previous close` };
    if (span.maxTs < to) return { whole: false, reason: `${stream} has no row at or after the close` };
  }
  return { whole: true, by: "rows" };
}
