import type { Database } from "better-sqlite3";

/**
 * Session-day → contract mapping, derived from NT8's mirrored rollover table.
 * Windows are [rolloverDate, next rolloverDate); `label >= rolloverDate` means
 * the new contract, and the private consumer compares the same way — keep the
 * two in lockstep. A merged BarsRequest resolves ONE instrument but serves bars
 * from every contract it spans, so only the mirror can attribute a row.
 */
export interface RolloverWindow {
  rolloverDate: string; // ISO YYYY-MM-DD
  contractMonth: string; // ISO YYYY-MM-DD (first of the delivery month)
}

/** Rejects "2026-02-30", which `new Date` would silently roll into March. */
function isCanonicalIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Mirrored windows for a symbol, ascending. Returns empty on ANY non-canonical
 * row: one bad date mis-attributes its neighbours, and this path can't throw
 * (a corrupt mirror must not break the candle path), so refusing = label nothing.
 */
export function loadRolloverWindows(db: Database, symbol: string): RolloverWindow[] {
  const rows = db
    .prepare(
      `SELECT contract_month AS contractMonth, rollover_date AS rolloverDate
         FROM contract_rollovers WHERE symbol = ? ORDER BY rollover_date ASC`,
    )
    .all(symbol) as RolloverWindow[];
  for (const r of rows) {
    if (!isCanonicalIsoDate(r.rolloverDate) || !isCanonicalIsoDate(r.contractMonth)) {
      console.error(
        `[contract-windows] contract_rollovers holds a non-canonical date for ${symbol} ` +
          `(rollover_date=${r.rolloverDate}, contract_month=${r.contractMonth}) — the mirror ` +
          `is corrupt; labelling nothing until it is re-synced`,
      );
      return [];
    }
  }
  return rows;
}

/** ("NQ", "2026-09-01") → "NQ 09-26". Must match Instrument.FullName, which is
 *  what bar_close reports, or the cross-checks compare nothing. */
export function contractName(symbol: string, contractMonth: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(contractMonth);
  if (!m) return `${symbol} ?`;
  return `${symbol} ${m[2]}-${m[1].slice(2)}`;
}

/** Contract serving session-day `label`. Null when no window covers it —
 *  unattested, never guessed. */
export function contractForLabel(
  windows: RolloverWindow[],
  symbol: string,
  label: string,
): string | null {
  let current: RolloverWindow | null = null;
  for (const w of windows) {
    if (w.rolloverDate <= label) current = w;
    else break;
  }
  return current ? contractName(symbol, current.contractMonth) : null;
}
