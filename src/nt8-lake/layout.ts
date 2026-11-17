import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { envSetting } from "../core/env-local.js";
import { dataDir } from "../hub/config.js";
import { REGISTRY } from "../core/sessions/registry.js";
import { INSTRUMENTS } from "../core/instruments/tick-size.js";
import { RefusedError } from "./source.js";

export const FORMAT = "ticks.v1";
export const LOCK_FILE = "ingest.lock";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LABEL = /^\d{4}-\d{2}-\d{2}$/;
const TAKE_DIR = /^take=([1-9][0-9]*)$/;
export const TEMP_MARK = ".tmp-";

export function lakeRoot(): string {
  const configured = envSetting("NT8_LAKE_PATH");
  return configured ? path.resolve(configured) : path.join(dataDir(), "nt8-lake");
}

export interface Identity {
  instrument: string;
  symbol: string;
  contract: string;
}

export function identify(instrument: string): Identity {
  const space = instrument.indexOf(" ");
  if (space <= 0) throw new RefusedError(`instrument "${instrument}" is not "<symbol> <expiry>"`);
  const symbol = instrument.slice(0, space);
  const contract = instrument.replace(" ", "_");
  if (!TOKEN.test(symbol) || !TOKEN.test(contract)) {
    throw new RefusedError(`instrument "${instrument}" does not make a valid path token (${TOKEN})`);
  }
  if (!(symbol in REGISTRY) || !(symbol in INSTRUMENTS)) {
    throw new RefusedError(`unknown symbol "${symbol}": it must be in core/sessions/registry.ts and core/instruments/tick-size.ts`);
  }
  return { instrument, symbol, contract };
}

export function identifyContract(contract: string): Identity {
  return identify(contract.includes(" ") ? contract : contract.replace("_", " "));
}

export function assertLabel(label: string): void {
  if (!LABEL.test(label)) throw new RefusedError(`bad session-day label "${label}" (want YYYY-MM-DD)`);
}

export function contractDir(root: string, id: Identity): string {
  return path.join(root, "ticks", `symbol=${id.symbol}`, `contract=${id.contract}`);
}

export function sessionDir(root: string, id: Identity, label: string): string {
  return path.join(contractDir(root, id), `session=${label}`);
}

export function takeDir(root: string, id: Identity, label: string, take: number): string {
  return path.join(sessionDir(root, id, label), `take=${take}`);
}

export function streamFile(dir: string, stream: string): string {
  return path.join(dir, `${stream}.parquet`);
}

function subdirs(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix) && !e.name.includes(TEMP_MARK))
    .map((e) => e.name.slice(prefix.length))
    .sort();
}

export function listTakes(sessionPath: string): number[] {
  if (!existsSync(sessionPath)) return [];
  return readdirSync(sessionPath, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => TAKE_DIR.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/** Leftovers of a write that never reached its rename. */
export function listTempDirs(sessionPath: string): string[] {
  if (!existsSync(sessionPath)) return [];
  return readdirSync(sessionPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.includes(TEMP_MARK))
    .map((e) => path.join(sessionPath, e.name));
}

export interface StoredDay {
  id: Identity;
  label: string;
  dir: string;
}

export function listContracts(root: string): Identity[] {
  const out: Identity[] = [];
  for (const symbol of subdirs(path.join(root, "ticks"), "symbol=")) {
    for (const contract of subdirs(path.join(root, "ticks", `symbol=${symbol}`), "contract=")) {
      out.push({ instrument: `${symbol} ${contract.slice(symbol.length + 1)}`, symbol, contract });
    }
  }
  return out;
}

export function listDays(root: string, id: Identity): StoredDay[] {
  return subdirs(contractDir(root, id), "session=")
    .filter((label) => LABEL.test(label))
    .map((label) => ({ id, label, dir: sessionDir(root, id, label) }));
}
