import type { ExperimentRecord, ExperimentStatus } from "../types.js";
import type { ExperimentStore } from "./types.js";

const ACTIVE: ExperimentStatus[] = ["queued", "running"];

/** Zero-dependency in-memory store. Great for tests and for evaluating the lab
 *  without a database. Not durable across process restarts. */
export class MemoryExperimentStore implements ExperimentStore {
  private readonly byId = new Map<string, ExperimentRecord>();

  create(rec: ExperimentRecord): void {
    this.byId.set(rec.id, { ...rec });
  }

  update(id: string, patch: Partial<ExperimentRecord>): void {
    const cur = this.byId.get(id);
    if (!cur) return;
    this.byId.set(id, { ...cur, ...patch });
  }

  get(id: string): ExperimentRecord | undefined {
    const r = this.byId.get(id);
    return r ? { ...r } : undefined;
  }

  list(filter?: { status?: ExperimentStatus }): ExperimentRecord[] {
    let rows = [...this.byId.values()];
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    return rows.sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r }));
  }

  countActive(): number {
    let n = 0;
    for (const r of this.byId.values()) if (ACTIVE.includes(r.status)) n++;
    return n;
  }
}
