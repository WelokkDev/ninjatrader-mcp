import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMPTY_CALENDAR, type SessionCalendar } from "../../src/core/sessions/calendar.js";
import { sessionDayRange } from "../../src/core/sessions/session-day.js";
import { CME_US_INDEX_FUTURES_ETH } from "../../src/core/sessions/templates.js";
import type { RefBar, ReferenceBars } from "../../src/nt8-lake/checks.js";
import type { LakeContext } from "../../src/nt8-lake/ops.js";
import { cutsSpanning, TS_PER_SEC, type Cut } from "../../src/nt8-lake/session-cut.js";
import type { Row } from "../../src/nt8-lake/source.js";

export const CME = CME_US_INDEX_FUTURES_ETH;

const made: string[] = [];

export function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nt8-lake-test-"));
  made.push(dir);
  return dir;
}

export function removeTmpRoots(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function ts(unixSec: number, frac100ns = 0): bigint {
  return BigInt(unixSec) * TS_PER_SEC + BigInt(frac100ns);
}

/** Exact decimal text for a whole number of quarter ticks. */
export function px(ticks: number): string {
  const sign = ticks < 0 ? "-" : "";
  const a = Math.abs(ticks);
  const frac = (a % 4) * 25;
  return frac === 0 ? `${sign}${Math.floor(a / 4)}` : `${sign}${Math.floor(a / 4)}.${String(frac).padStart(2, "0")}`;
}

export function cutOf(label: string): Cut {
  const { endUnix } = sessionDayRange(label, CME);
  return cutsSpanning(ts(endUnix) - 1n, ts(endUnix) - 1n, CME).find((c) => c.label === label)!;
}

export interface Streams {
  prints: Row[];
  bid: Row[];
  ask: Row[];
}

/** One pad row of each stream 5 s outside each end of the cut proves the day whole. */
export function syntheticDay(label: string, opts: { pad?: boolean } = {}): Streams {
  const { startUnix: open, endUnix: close } = sessionDayRange(label, CME);
  const cut = cutOf(label);
  const out: Streams = { prints: [], bid: [], ask: [] };
  const add = (t: bigint, i: number) => {
    const b = 120_000 + (i % 7);
    out.bid.push({ ts: t, px: px(b), size: 5 + (i % 4) });
    out.ask.push({ ts: t, px: px(b + 1), size: 6 + (i % 3) });
    const atBid = i % 2 === 0;
    out.prints.push({ ts: t + 5_000_000n, px: px(atBid ? b : b + 1), size: 1 + (i % 3), bid: px(b), ask: px(b + 1) });
  };
  if (opts.pad !== false) add(ts(cut.from - 5), -1);
  let i = 0;
  for (let t = open; t < close; t += 30) add(ts(t), i++);
  if (opts.pad !== false) add(ts(cut.to + 5), i);
  return out;
}

export function barsOf(prints: Row[], cut: Cut): RefBar[] {
  const bars = new Map<number, RefBar>();
  for (const p of prints) {
    if (p.ts === null || p.ts < ts(cut.from) || p.ts >= ts(cut.to)) continue;
    const t = Number(p.ts / TS_PER_SEC) + 1;
    const price = Number(p.px);
    const size = Number(p.size);
    const b = bars.get(t);
    if (!b) bars.set(t, { timestamp: t, open: price, high: price, low: price, close: price, volume: size });
    else {
      b.high = Math.max(b.high, price);
      b.low = Math.min(b.low, price);
      b.close = price;
      b.volume += size;
    }
  }
  return [...bars.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function context(root: string, over: Partial<LakeContext> & { calendar?: SessionCalendar; bars?: RefBar[] } = {}): LakeContext {
  const reference: ReferenceBars = async (_c, from, to) => (over.bars ?? []).filter((b) => b.timestamp > from && b.timestamp <= to);
  return {
    root,
    calendarFor: () => over.calendar ?? EMPTY_CALENDAR,
    referenceBars: over.referenceBars ?? reference,
  };
}
