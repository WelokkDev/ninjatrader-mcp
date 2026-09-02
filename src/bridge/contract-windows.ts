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

const MMM = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Delivery month behind an NT8 contract name. Installs render `FullName` as
 *  either "NQ 09-26" or "NQ SEP26", so comparing raw strings silently breaks
 *  every cross-check between a mirror-built name and a wire-reported one. */
export function parseContractName(
  name: string,
): { symbol: string; year: number; month: number } | null {
  const m = /^(\S+)\s+(?:(\d{2})-(\d{2})|([A-Za-z]{3})(\d{2}))$/.exec(name.trim());
  if (!m) return null;
  const symbol = m[1];
  if (m[2] !== undefined) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { symbol, year: 2000 + Number(m[3]), month };
  }
  const idx = MMM.indexOf(m[4].toUpperCase());
  if (idx < 0) return null;
  return { symbol, year: 2000 + Number(m[5]), month: idx + 1 };
}

/** Same instrument and delivery month, in either rendering. Unparseable names
 *  fall back to exact equality rather than being treated as a match. */
export function sameContract(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = parseContractName(a);
  const pb = parseContractName(b);
  if (pa === null || pb === null) return a.trim() === b.trim();
  return (
    pa.symbol.toUpperCase() === pb.symbol.toUpperCase() &&
    pa.year === pb.year &&
    pa.month === pb.month
  );
}

/** The window covering `label`. Exposed so callers can ask whether a window has
 *  opened yet, which `contractForLabel` alone cannot answer. */
export function windowForLabel(
  windows: RolloverWindow[],
  label: string,
): RolloverWindow | null {
  let current: RolloverWindow | null = null;
  for (const w of windows) {
    if (w.rolloverDate <= label) current = w;
    else break;
  }
  return current;
}

/** Contract serving session-day `label`. Null when no window covers it —
 *  unattested, never guessed. */
export function contractForLabel(
  windows: RolloverWindow[],
  symbol: string,
  label: string,
): string | null {
  const current = windowForLabel(windows, label);
  return current ? contractName(symbol, current.contractMonth) : null;
}
