import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeSchema } from "../../db/schema.js";
import { REGISTRY } from "../../core/sessions/registry.js";
import { BridgeRequestError } from "../connection.js";
import { parseMessage } from "../protocol.js";
import { syncContractRollovers } from "../rollover-sync.js";

function memDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

/** The June 2026 roll as NT8 actually reports it — 06-12, which neither the
 *  lake nor CME matches (see the contract_rollovers doctrine in db/schema.ts). */
const NQ_ROLLOVERS = [
  { contractMonth: "2026-06-01", rolloverDate: "2026-03-16", offset: 208.75, wasEdited: false },
  { contractMonth: "2026-09-01", rolloverDate: "2026-06-12", offset: 282.25, wasEdited: false },
];

/** What the AddOn puts on the wire, minus the envelope fields the mocks skip. */
function rolloversResponse(symbol: unknown, rollovers: unknown[] = []) {
  return {
    type: "rollovers_response",
    symbol,
    mergePolicy: "MergeNonBackAdjusted",
    priceBasis: "as_traded",
    rollovers,
  };
}

function rowsFor(db: Database.Database, symbol: string) {
  return db
    .prepare(
      `SELECT contract_month, rollover_date, offset_points, was_edited
         FROM contract_rollovers WHERE symbol = ? ORDER BY contract_month`,
    )
    .all(symbol) as Array<{
    contract_month: string;
    rollover_date: string;
    offset_points: number;
    was_edited: number;
  }>;
}

describe("rollovers_response protocol messages", () => {
  // Pins a shipped regression: the schema existed but was missing from
  // INBOUND_SCHEMAS, so every reply was dropped as "unknown type" before
  // correlation and the sync could only ever time out.
  it("parses a valid rollovers_response off the wire", () => {
    const r = parseMessage(
      JSON.stringify({
        v: 1,
        id: "req-1",
        type: "rollovers_response",
        symbol: "NQ",
        instrument: "NQ SEP26",
        mergePolicy: "MergeNonBackAdjusted",
        priceBasis: "as_traded",
        rollovers: NQ_ROLLOVERS,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "rollovers_response") {
      expect(r.message.rollovers[1].rolloverDate).toBe("2026-06-12");
    } else {
      throw new Error("wrong type");
    }
  });

  it("rejects a response with malformed entries", () => {
    const r = parseMessage(
      JSON.stringify({
        v: 1,
        id: "req-1",
        type: "rollovers_response",
        symbol: "NQ",
        rollovers: [{ contractMonth: "2026-09-01" }], // missing rolloverDate/offset
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("syncContractRollovers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = memDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the table NT8 reports, and the offsets with it", async () => {
    const request = vi.fn(async (_type: string, payload: Record<string, unknown>) =>
      rolloversResponse(payload.symbol, NQ_ROLLOVERS),
    );

    const res = await syncContractRollovers({ db, request, nowUnix: 1_700_000_000 });

    expect(res.failed).toBe(0);

    const rows = rowsFor(db, "NQ");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      contract_month: "2026-09-01",
      rollover_date: "2026-06-12",
      offset_points: 282.25,
    });
  });

  it("surfaces the effective merge policy on every sync — the silent-flip alarm", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(async (_t: string, payload: Record<string, unknown>) =>
      rolloversResponse(payload.symbol, NQ_ROLLOVERS),
    );

    await syncContractRollovers({ db, request, nowUnix: 1 });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("NQ: 2 rollover(s)"))).toBe(true);
    expect(lines.some((l) => l.includes("mergePolicy=MergeNonBackAdjusted"))).toBe(true);
  });

  it("logs an empty-string policy as unknown rather than printing nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(async (_t: string, payload: Record<string, unknown>) => ({
      ...rolloversResponse(payload.symbol, NQ_ROLLOVERS),
      mergePolicy: "",
      priceBasis: "",
    }));

    await syncContractRollovers({ db, request, nowUnix: 1 });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("mergePolicy=unknown"))).toBe(true);
    expect(lines.some((l) => l.includes("mergePolicy= "))).toBe(false);
  });

  it("re-syncs in place when NT8 moves a rollover date", async () => {
    // Future rows ship as unfinalized placeholders and NT8 revises them.
    const first = vi.fn(async () => rolloversResponse("NQ", [NQ_ROLLOVERS[1]]));
    await syncContractRollovers({ db, request: first, nowUnix: 1 });

    const second = vi.fn(async () =>
      rolloversResponse("NQ", [{ ...NQ_ROLLOVERS[1], rolloverDate: "2026-06-15", offset: 300.5 }]),
    );
    await syncContractRollovers({ db, request: second, nowUnix: 2 });

    const rows = rowsFor(db, "NQ");
    const sep = rows.filter((r) => r.contract_month === "2026-09-01");
    expect(sep).toHaveLength(1);
    expect(sep[0].rollover_date).toBe("2026-06-15");
    expect(sep[0].offset_points).toBe(300.5);
  });

  it("drops rows NT8 no longer reports — a mirror, not an accumulator", async () => {
    // A row that vanished upstream but survived here reads as a phantom roll
    // boundary, splitting a real [rollover_date, next) window in two.
    const first = vi.fn(async () => rolloversResponse("NQ", NQ_ROLLOVERS));
    await syncContractRollovers({ db, request: first, nowUnix: 1 });
    expect(rowsFor(db, "NQ")).toHaveLength(2);

    const second = vi.fn(async () => rolloversResponse("NQ", [NQ_ROLLOVERS[1]]));
    await syncContractRollovers({ db, request: second, nowUnix: 2 });

    const rows = rowsFor(db, "NQ");
    expect(rows).toHaveLength(1);
    expect(rows[0].contract_month).toBe("2026-09-01");
  });

  it("keeps the mirror when NT8 answers success-with-zero-rows", async () => {
    // Wiping on a fresh install's empty reply would silently disarm the lake
    // splice's roll guard.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = vi.fn(async () => rolloversResponse("NQ", NQ_ROLLOVERS));
    await syncContractRollovers({ db, request: first, nowUnix: 1 });
    expect(rowsFor(db, "NQ")).toHaveLength(2);

    const empty = vi.fn(async (_t: string, payload: Record<string, unknown>) =>
      rolloversResponse(payload.symbol, []),
    );
    const res = await syncContractRollovers({ db, request: empty, nowUnix: 2 });

    expect(rowsFor(db, "NQ")).toHaveLength(2); // survived
    expect(res.synced).toBe(0);
    expect(res.failed).toBeGreaterThan(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("keeping the existing mirror"))).toBe(true);
  });

  it("records wasEdited, because NinjaTrader may overwrite hand-edited offsets", async () => {
    const request = vi.fn(async () =>
      rolloversResponse("NQ", [{ ...NQ_ROLLOVERS[1], wasEdited: true }]),
    );
    await syncContractRollovers({ db, request, nowUnix: 1 });
    expect(rowsFor(db, "NQ")[0].was_edited).toBe(1);
  });

  it("stops after ONE timeout — an old AddOn never replies at all", async () => {
    // It drops the message without replying, so every symbol would burn a full
    // timeout for the same answer.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(async () => {
      throw new BridgeRequestError("Request request_rollovers timed out after 10000ms", "timeout", true);
    });

    const res = await syncContractRollovers({ db, request, nowUnix: 1 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(res.synced).toBe(0);
    expect(res.failed).toBe(Object.keys(REGISTRY).length);
    expect(rowsFor(db, "NQ")).toHaveLength(0);
  });

  it("keeps one symbol's non-timeout failure from blocking the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(async (_t: string, payload: Record<string, unknown>) => {
      if (payload.symbol === "NQ") throw new Error("boom");
      return rolloversResponse(payload.symbol, NQ_ROLLOVERS);
    });

    const res = await syncContractRollovers({ db, request, nowUnix: 1 });

    expect(res.failed).toBe(1);
    expect(res.synced).toBeGreaterThan(0);
    expect(rowsFor(db, "NQ")).toHaveLength(0);
    expect(rowsFor(db, "MNQ").length).toBeGreaterThan(0);
  });

  it("rejects a drifted reply instead of reading fields off it", async () => {
    // Correlation is by id, not type, so a confused AddOn can resolve with any
    // message. This one carries a well-formed `rollovers` array, so only a real
    // type check — not a missing-field crash — can catch it.
    const seeded = vi.fn(async () => rolloversResponse("NQ", NQ_ROLLOVERS));
    await syncContractRollovers({ db, request: seeded, nowUnix: 1 });
    expect(rowsFor(db, "NQ")).toHaveLength(2);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(async () => ({
      type: "candles_response",
      mergePolicy: "MergeNonBackAdjusted",
      priceBasis: "as_traded",
      rollovers: [],
    }));

    const res = await syncContractRollovers({ db, request, nowUnix: 2 });

    expect(res.synced).toBe(0);
    expect(res.failed).toBe(Object.keys(REGISTRY).length);
    // The drifted reply must not reach the DELETE.
    expect(rowsFor(db, "NQ")).toHaveLength(2);
  });
});
