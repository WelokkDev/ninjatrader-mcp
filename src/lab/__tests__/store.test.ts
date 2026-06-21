import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { MemoryExperimentStore } from "../store/memory-store.js";
import { SqliteExperimentStore } from "../store/sqlite-store.js";
import type { ExperimentStore } from "../store/types.js";
import type { ExperimentRecord } from "../types.js";

function rec(id: string, status: ExperimentRecord["status"], createdAt: number): ExperimentRecord {
  return {
    id,
    status,
    runner: "fake",
    spec: { symbol: "NQ", startDay: "2026-04-01", endDay: "2026-05-01" },
    createdAt,
  };
}

const factories: Array<[string, () => ExperimentStore]> = [
  ["memory", () => new MemoryExperimentStore()],
  ["sqlite", () => new SqliteExperimentStore(new Database(":memory:"))],
];

describe.each(factories)("ExperimentStore: %s", (_name, make) => {
  it("create + get round-trips", () => {
    const s = make();
    s.create(rec("a", "queued", 1));
    expect(s.get("a")?.status).toBe("queued");
    expect(s.get("missing")).toBeUndefined();
  });

  it("update shallow-merges and is a no-op for unknown ids", () => {
    const s = make();
    s.create(rec("a", "queued", 1));
    s.update("a", { status: "running", unitsDone: 5 });
    expect(s.get("a")?.status).toBe("running");
    expect(s.get("a")?.unitsDone).toBe(5);
    expect(() => s.update("nope", { status: "done" })).not.toThrow();
  });

  it("list is newest-first and filters by status", () => {
    const s = make();
    s.create(rec("old", "done", 1));
    s.create(rec("new", "done", 2));
    s.create(rec("q", "queued", 3));
    expect(s.list().map((r) => r.id)).toEqual(["q", "new", "old"]);
    expect(s.list({ status: "done" }).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("countActive counts queued + running only", () => {
    const s = make();
    s.create(rec("a", "queued", 1));
    s.create(rec("b", "running", 2));
    s.create(rec("c", "done", 3));
    s.create(rec("d", "failed", 4));
    expect(s.countActive()).toBe(2);
  });
});
