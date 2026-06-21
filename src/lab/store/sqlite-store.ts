import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ExperimentRecord, ExperimentStatus } from "../types.js";
import type { ExperimentStore } from "./types.js";

// The store keeps the full record as JSON for forward-compat, plus a few
// promoted columns (status, created_at) so list/count are indexed and never
// have to parse JSON. Self-contained: it owns its own table and pragmas, so it
// does NOT depend on the host project's schema.

const DDL = `
CREATE TABLE IF NOT EXISTS lab_experiments (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_experiments_status     ON lab_experiments (status);
CREATE INDEX IF NOT EXISTS idx_lab_experiments_created_at ON lab_experiments (created_at);
`;

export class SqliteExperimentStore implements ExperimentStore {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly updateStmt;
  private readonly listAllStmt;
  private readonly listByStatusStmt;
  private readonly countActiveStmt;

  constructor(private readonly db: DatabaseType) {
    // Reliability: one writer under WAL with no busy_timeout throws SQLITE_BUSY
    // immediately under contention. These make concurrent jobs survivable.
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(DDL);

    this.insertStmt = db.prepare(
      "INSERT OR REPLACE INTO lab_experiments (id, status, created_at, json) VALUES (@id, @status, @created_at, @json)",
    );
    this.getStmt = db.prepare("SELECT json FROM lab_experiments WHERE id = ?");
    this.updateStmt = db.prepare(
      "UPDATE lab_experiments SET status = @status, json = @json WHERE id = @id",
    );
    this.listAllStmt = db.prepare(
      "SELECT json FROM lab_experiments ORDER BY created_at DESC",
    );
    this.listByStatusStmt = db.prepare(
      "SELECT json FROM lab_experiments WHERE status = ? ORDER BY created_at DESC",
    );
    this.countActiveStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM lab_experiments WHERE status IN ('queued','running')",
    );
  }

  create(rec: ExperimentRecord): void {
    this.insertStmt.run({
      id: rec.id,
      status: rec.status,
      created_at: rec.createdAt,
      json: JSON.stringify(rec),
    });
  }

  update(id: string, patch: Partial<ExperimentRecord>): void {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.updateStmt.run({ id, status: next.status, json: JSON.stringify(next) });
  }

  get(id: string): ExperimentRecord | undefined {
    const row = this.getStmt.get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ExperimentRecord) : undefined;
  }

  list(filter?: { status?: ExperimentStatus }): ExperimentRecord[] {
    const rows = (
      filter?.status ? this.listByStatusStmt.all(filter.status) : this.listAllStmt.all()
    ) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as ExperimentRecord);
  }

  countActive(): number {
    const row = this.countActiveStmt.get() as { n: number };
    return row.n;
  }
}

/** Convenience: open a dedicated lab database file with sane pragmas. */
export function openLabDatabase(dbPath: string): DatabaseType {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}
