import { createRequire } from "node:module";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { envSetting } from "../core/env-local.js";
import { RefusedError } from "./source.js";

// The only importer of @duckdb/node-api. Loaded on first use so a machine
// whose native binary fails to load keeps everything else working.

export const MEMORY_LIMIT_KEY = "NT8_LAKE_MEMORY_LIMIT";
export const DEFAULT_MEMORY_LIMIT = "16GB";
export const THREADS = 2;

export class EngineUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`DuckDB could not be loaded (@duckdb/node-api): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "EngineUnavailableError";
  }
}

export interface Engine {
  readonly con: DuckDBConnection;
  readonly version: string;
  readonly nodeApiVersion: string;
  readonly memoryLimit: string;
  close(): void;
}

export type JsonRow = Record<string, unknown>;

export async function openEngine(): Promise<Engine> {
  let mod: typeof import("@duckdb/node-api");
  try {
    mod = await import("@duckdb/node-api");
  } catch (err) {
    throw new EngineUnavailableError(err);
  }
  const override = envSetting(MEMORY_LIMIT_KEY);
  const memoryLimit = override ?? DEFAULT_MEMORY_LIMIT;
  let instance: DuckDBInstance;
  try {
    // Without temp_directory '' an in-memory database spills into <cwd>/.tmp.
    instance = await mod.DuckDBInstance.create(":memory:", {
      temp_directory: "",
      memory_limit: memoryLimit,
      threads: String(THREADS),
    });
  } catch (err) {
    if (override === undefined) throw err;
    throw new RefusedError(`${MEMORY_LIMIT_KEY}="${override}" is not a memory size DuckDB accepts (e.g. 24GB): ${firstLine(err)}`);
  }
  const con = await instance.connect();
  await con.run("SET preserve_insertion_order = true");
  const version = String((await rows(con, "SELECT version() AS v"))[0].v);
  return {
    con,
    version,
    nodeApiVersion: nodeApiVersion(),
    memoryLimit,
    close() {
      con.closeSync();
      instance.closeSync();
    },
  };
}

export function isOutOfMemory(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Out of Memory Error");
}

export async function withEngine<T>(fn: (engine: Engine) => Promise<T>): Promise<T> {
  const engine = await openEngine();
  try {
    return await fn(engine);
  } catch (err) {
    if (!isOutOfMemory(err)) throw err;
    throw new RefusedError(
      `DuckDB needed more than its ${engine.memoryLimit} memory limit, and the lake never spills to disk. ` +
        `To retry on purpose, raise ${MEMORY_LIMIT_KEY} in .env.local. (${firstLine(err)})`,
    );
  } finally {
    engine.close();
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

function nodeApiVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return String((req("@duckdb/node-api/package.json") as { version: string }).version);
  } catch {
    return "unknown";
  }
}

/** Rows as JSON-safe values: BIGINT/HUGEINT arrive as decimal strings. */
export async function rows(con: DuckDBConnection, sql: string): Promise<JsonRow[]> {
  return (await con.runAndReadAll(sql)).getRowObjectsJson() as JsonRow[];
}

export function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
