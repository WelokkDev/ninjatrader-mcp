import type { ExperimentRecord, ExperimentStatus } from "../types.js";

/**
 * Where experiment lifecycle records live. Two implementations ship:
 *  - MemoryExperimentStore  (zero deps; tests, demos, a friend's quick drop-in)
 *  - SqliteExperimentStore  (durable; survives MCP restarts, drives the cap)
 * Implement this interface to back the lab with Postgres, Redis, etc.
 */
export interface ExperimentStore {
  create(rec: ExperimentRecord): void;
  /** Shallow-merge a patch into an existing record. No-op if id is unknown. */
  update(id: string, patch: Partial<ExperimentRecord>): void;
  get(id: string): ExperimentRecord | undefined;
  /** Most-recent-first. */
  list(filter?: { status?: ExperimentStatus }): ExperimentRecord[];
  /** queued + running — the live count the concurrency cap reads. */
  countActive(): number;
  close?(): void;
}
