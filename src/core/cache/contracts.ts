import type { Database } from "better-sqlite3";
import { RAW_TIMEFRAMES, SUPPORTED_TIMEFRAMES } from "../constants.js";
import { UNATTESTED_CONTRACT } from "../../db/schema.js";
import type { SessionCalendar } from "../sessions/calendar.js";
import type { InstrumentConfig, SessionDay } from "../sessions/types.js";
import type { Timeframe } from "../types.js";
import { recomputeDerivedForSessionDay } from "./derived.js";

// Front assignment hides rows (`front = 0`), never deletes them. The one
// delete in this module is `replaceUnattestedTwins`.

export type DecidedBy = "fetch" | "live";

export interface FrontAssignment {
  contract: string;
  decidedBy: string;
  updatedAt: number;
}

export function frontContractFor(
  db: Database,
  symbol: string,
  label: string,
): FrontAssignment | null {
  const row = db
    .prepare(
      `SELECT contract, decided_by AS decidedBy, updated_at AS updatedAt
         FROM session_contracts WHERE symbol = ? AND session_day = ?`,
    )
    .get(symbol, label) as FrontAssignment | undefined;
  return row ?? null;
}

export function soleAttestedContract(
  db: Database,
  symbol: string,
  timeframe: Timeframe,
  day: SessionDay,
): string | null {
  const rows = db
    .prepare(
      `SELECT DISTINCT contract AS c FROM bars
        WHERE symbol = ? AND timeframe = ? AND contract <> ''
          AND timestamp > ? AND timestamp <= ?`,
    )
    .all(symbol, timeframe, day.startUnix, day.endUnix) as Array<{ c: string }>;
  return rows.length === 1 ? rows[0].c : null;
}

// Queried per timeframe so each is a range seek on the key, not a symbol scan.
function rowsByContractOnDay(db: Database, symbol: string, day: SessionDay): Map<string, number> {
  const out = new Map<string, number>();
  const stmt = db.prepare(
    `SELECT contract AS c, COUNT(*) AS n FROM bars
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
      GROUP BY contract`,
  );
  for (const tf of SUPPORTED_TIMEFRAMES) {
    for (const r of stmt.all(symbol, tf, day.startUnix, day.endUnix) as Array<{
      c: string;
      n: number;
    }>) {
      out.set(r.c, (out.get(r.c) ?? 0) + r.n);
    }
  }
  return out;
}

export interface AssignOutcome {
  changed: boolean;
  previous: string | null;
  displaced: string[];
  hiddenRows: number;
  hiddenUnattested: number;
}

/** Flips the day at every timeframe. Not transactional: the caller owns it. */
export function assignFrontContract(
  db: Database,
  symbol: string,
  day: SessionDay,
  contract: string,
  decidedBy: DecidedBy,
  nowUnix: number,
  geometry?: { config: InstrumentConfig; calendar: SessionCalendar },
): AssignOutcome {
  if (contract === UNATTESTED_CONTRACT) {
    // The flip below would hide every attested row on the day.
    throw new Error("assignFrontContract: a day's front must be an attested contract");
  }
  const current = frontContractFor(db, symbol, day.label);
  if (current?.contract === contract) {
    return {
      changed: false, previous: contract, displaced: [], hiddenRows: 0, hiddenUnattested: 0,
    };
  }
  db.prepare(
    `INSERT INTO session_contracts
       (symbol, session_day, start_unix, end_unix, contract, decided_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (symbol, session_day) DO UPDATE SET
       start_unix = excluded.start_unix, end_unix = excluded.end_unix,
       contract = excluded.contract, decided_by = excluded.decided_by,
       updated_at = excluded.updated_at`,
  ).run(symbol, day.label, day.startUnix, day.endUnix, contract, decidedBy, nowUnix);

  const present = rowsByContractOnDay(db, symbol, day);
  const displaced = [...present.keys()]
    .filter((c) => c !== contract && c !== UNATTESTED_CONTRACT)
    .sort();
  const hiddenRows = displaced.reduce((acc, c) => acc + (present.get(c) ?? 0), 0);

  // Before the flip; raw timeframes only, since derived rows are rebuilt.
  let hiddenUnattested = 0;
  if (present.has(UNATTESTED_CONTRACT)) {
    const servedUnattested = db.prepare(
      `SELECT COUNT(*) AS n FROM bars
        WHERE symbol = ? AND timeframe = ? AND contract = '' AND front = 1
          AND timestamp > ? AND timestamp <= ?`,
    );
    for (const tf of RAW_TIMEFRAMES) {
      hiddenUnattested += (
        servedUnattested.get(symbol, tf, day.startUnix, day.endUnix) as { n: number }
      ).n;
    }
  }

  const flip = db.prepare(
    `UPDATE bars SET front = (contract = ?)
      WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
        AND front <> (contract = ?)`,
  );
  for (const tf of SUPPORTED_TIMEFRAMES) {
    flip.run(contract, symbol, tf, day.startUnix, day.endUnix, contract);
  }

  if (hiddenUnattested > 0) {
    recordContractEvent(db, {
      symbol,
      sessionDay: day.label,
      kind: "unattested_hidden",
      from: UNATTESTED_CONTRACT,
      to: contract,
      ts: nowUnix,
      count: hiddenUnattested,
      detail: `decided by ${decidedBy}`,
    });
  }
  if (displaced.length > 0) {
    recordContractEvent(db, {
      symbol,
      sessionDay: day.label,
      kind: "reassigned",
      from: displaced.join(","),
      to: contract,
      ts: nowUnix,
      count: 1,
      detail: `${hiddenRows} bar(s) kept, no longer served; decided by ${decidedBy}`,
    });
    if (geometry) {
      recomputeDerivedForSessionDay(
        db, symbol, day, geometry.config, geometry.calendar, nowUnix,
      );
    }
  }
  return {
    changed: true,
    previous: current?.contract ?? null,
    displaced,
    hiddenRows,
    hiddenUnattested,
  };
}

// Keeps IN (?, ...) deletes under SQLITE_MAX_VARIABLE_NUMBER (32766).
const TWIN_CHUNK = 5000;

/** Drops the unattested bar at each instant an attested refill writes — what
 *  INSERT OR REPLACE did before the contract joined the key. */
export function replaceUnattestedTwins(
  db: Database,
  symbol: string,
  timeframe: Timeframe,
  day: SessionDay,
  stamps: readonly number[],
): number {
  if (stamps.length === 0) return 0;
  const any = db
    .prepare(
      `SELECT 1 FROM bars
        WHERE symbol = ? AND timeframe = ? AND contract = ''
          AND timestamp > ? AND timestamp <= ? LIMIT 1`,
    )
    .get(symbol, timeframe, day.startUnix, day.endUnix);
  if (any === undefined) return 0;
  let removed = 0;
  for (let i = 0; i < stamps.length; i += TWIN_CHUNK) {
    const chunk = stamps.slice(i, i + TWIN_CHUNK);
    removed += db
      .prepare(
        `DELETE FROM bars WHERE symbol = ? AND timeframe = ? AND contract = ''
          AND timestamp IN (${chunk.map(() => "?").join(", ")})`,
      )
      .run(symbol, timeframe, ...chunk).changes;
  }
  return removed;
}

export type ContractEventKind =
  | "reassigned"
  | "off_front"
  | "unattested_hidden"
  | "bound_mismatch";

export interface ContractEvent {
  symbol: string;
  sessionDay: string;
  kind: ContractEventKind;
  from: string;
  to: string;
  firstTs: number;
  lastTs: number;
  count: number;
  detail: string | null;
}

/** True the first time a (day, kind, from, to) is seen, so callers log once. */
export function recordContractEvent(
  db: Database,
  e: {
    symbol: string;
    sessionDay: string;
    kind: ContractEventKind;
    from: string;
    to: string;
    ts: number;
    count: number;
    detail?: string;
  },
): boolean {
  const existed =
    db
      .prepare(
        `SELECT 1 FROM contract_events
          WHERE symbol = ? AND session_day = ? AND kind = ? AND from_contract = ? AND to_contract = ?`,
      )
      .get(e.symbol, e.sessionDay, e.kind, e.from, e.to) !== undefined;
  db.prepare(
    `INSERT INTO contract_events
       (symbol, session_day, kind, from_contract, to_contract, first_ts, last_ts, count, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (symbol, session_day, kind, from_contract, to_contract) DO UPDATE SET
       last_ts = excluded.last_ts,
       count = contract_events.count + excluded.count,
       detail = COALESCE(excluded.detail, contract_events.detail)`,
  ).run(e.symbol, e.sessionDay, e.kind, e.from, e.to, e.ts, e.ts, e.count, e.detail ?? null);
  return !existed;
}

// Labels are ISO dates, so string order is date order.
export function contractEventsFor(
  db: Database,
  symbol: string,
  firstLabel: string,
  lastLabel: string,
): ContractEvent[] {
  return db
    .prepare(
      `SELECT symbol, session_day AS sessionDay, kind, from_contract AS "from",
              to_contract AS "to", first_ts AS firstTs, last_ts AS lastTs, count, detail
         FROM contract_events
        WHERE symbol = ? AND session_day >= ? AND session_day <= ?
        ORDER BY session_day, first_ts`,
    )
    .all(symbol, firstLabel, lastLabel) as ContractEvent[];
}

export function describeContractEvent(e: ContractEvent): string {
  const name = (c: string): string => (c === UNATTESTED_CONTRACT ? "no contract" : c);
  const detail = e.detail ? ` (${e.detail})` : "";
  const when = `${new Date(e.lastTs * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  if (e.kind === "reassigned") {
    return `${e.sessionDay}: front contract moved ${name(e.from)} → ${name(e.to)} on ${when}${detail}`;
  }
  if (e.kind === "unattested_hidden") {
    return (
      `${e.sessionDay}: ${e.count} bar(s) with no contract label stopped being served on ${when}, ` +
      `when the front contract became ${name(e.to)} — kept, not deleted; re-fetch those ` +
      `timeframes to replace them${detail}`
    );
  }
  if (e.kind === "bound_mismatch") {
    return (
      `${e.sessionDay}: NinjaTrader's rollover table says ${name(e.from)} but the AddOn bound ` +
      `${name(e.to)} on ${e.count} fetch(es), last ${when} — a live stream resolved the same way ` +
      `is off-front; check live_feed_status and re-subscribe${detail}`
    );
  }
  return (
    `${e.sessionDay}: ${e.count} bar(s) arrived under ${name(e.to)} while the front contract ` +
    `is ${name(e.from)}, last ${when} — stored, not served${detail}`
  );
}

export function servesMixedContracts(
  db: Database,
  symbol: string,
  timeframe: Timeframe,
  day: SessionDay,
): boolean {
  const rows = db
    .prepare(
      `SELECT DISTINCT contract FROM bars
        WHERE symbol = ? AND timeframe = ? AND front = 1 AND timestamp > ? AND timestamp <= ?
        LIMIT 2`,
    )
    .all(symbol, timeframe, day.startUnix, day.endUnix);
  return rows.length > 1;
}

export interface ServedContracts {
  contracts: string[];
  mixedDays: Array<{ day: string; contracts: string[] }>;
}

export function servedContracts(
  db: Database,
  symbol: string,
  timeframe: Timeframe,
  days: readonly SessionDay[],
): ServedContracts {
  const stmt = db.prepare(
    `SELECT DISTINCT contract AS c FROM bars
      WHERE symbol = ? AND timeframe = ? AND front = 1 AND timestamp > ? AND timestamp <= ?
      ORDER BY c`,
  );
  const all = new Set<string>();
  const mixedDays: Array<{ day: string; contracts: string[] }> = [];
  for (const day of days) {
    const found = (stmt.all(symbol, timeframe, day.startUnix, day.endUnix) as Array<{ c: string }>)
      .map((r) => (r.c === UNATTESTED_CONTRACT ? "unattested" : r.c));
    for (const c of found) all.add(c);
    if (found.length > 1) mixedDays.push({ day: day.label, contracts: found });
  }
  return { contracts: [...all].sort(), mixedDays };
}
