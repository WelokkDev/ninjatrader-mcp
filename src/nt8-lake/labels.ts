import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { checksPath, type CheckResult, type ChecksFile } from "./checks.js";
import { listTakes } from "./layout.js";
import { writeJsonAtomic } from "./writer.js";

export type Tier = "RAW" | "CLEAN" | "GOLD";
export const TIER_ORDER: readonly Tier[] = ["RAW", "CLEAN", "GOLD"];

export interface Selection {
  take: number;
  by: "first" | "hand";
  at: string;
}

export interface GoldMark {
  take: number;
  at: string;
  note: string;
  waived: string[];
}

export interface DayFile {
  selection?: Selection;
  gold?: GoldMark;
  history?: ({ selection: Selection } | { gold: GoldMark; removedAt: string })[];
}

export function dayPath(sessionPath: string): string {
  return path.join(sessionPath, "day.json");
}

export function readDay(sessionPath: string): DayFile {
  const p = dayPath(sessionPath);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as DayFile) : {};
}

export function writeDay(sessionPath: string, day: DayFile): void {
  writeJsonAtomic(dayPath(sessionPath), day);
}

export function readChecks(takePath: string): ChecksFile | null {
  const p = checksPath(takePath);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as ChecksFile) : null;
}

/** A waiver names a check id ("no_long_gap.bid") or every stream of one ("no_long_gap"). */
export function isWaived(id: string, waived: readonly string[]): boolean {
  return waived.some((w) => w === id || id.startsWith(`${w}.`));
}

export interface DayState {
  takes: number[];
  selected: number | null;
  day: DayFile;
  checks: ChecksFile | null;
  /** Stored results plus `single_take`, which depends on the day, not the take. */
  results: CheckResult[];
  failing: CheckResult[];
  tier: Tier | null;
}

export function dayState(sessionPath: string): DayState {
  const takes = listTakes(sessionPath);
  const day = readDay(sessionPath);
  const selected = day.selection?.take ?? (takes.length > 0 ? takes[0] : null);
  if (selected === null || !takes.includes(selected)) {
    return { takes, selected, day, checks: null, results: [], failing: [], tier: null };
  }
  const checks = readChecks(path.join(sessionPath, `take=${selected}`));
  const single = takes.length === 1 || day.selection?.by === "hand";
  const results: CheckResult[] = [
    ...(checks?.results ?? [{ id: "checks", status: "fail" as const, detail: "checks.json is missing" }]),
    {
      id: "single_take",
      status: single ? "pass" : "fail",
      detail: single
        ? takes.length === 1
          ? "one take"
          : `take ${selected} selected by hand from ${takes.length}`
        : `${takes.length} takes and no selection by hand`,
    },
  ];
  const failing = results.filter((r) => r.status !== "pass" && r.status !== "skipped");
  let tier: Tier = failing.length === 0 ? "CLEAN" : "RAW";
  const gold = day.gold;
  if (gold && gold.take === selected && failing.every((r) => isWaived(r.id, gold.waived))) tier = "GOLD";
  return { takes, selected, day, checks, results, failing, tier };
}

export function atLeast(tier: Tier, min: Tier): boolean {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(min);
}
