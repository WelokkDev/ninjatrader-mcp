import type { Database } from "better-sqlite3";
import defaultDb from "../db/connection.js";
import { REGISTRY } from "../core/sessions/registry.js";
import { request as bridgeRequest } from "./index.js";
import { isInboundType } from "./protocol.js";
import { registerHelloSync, runHelloSync, type HelloSyncResult } from "./hello-sync.js";

// Mirrors NT8's contract rollover table into SQLite on every hello — re-read
// per connection, since NinjaTrader revises rows in place. Table doctrine lives
// on the contract_rollovers DDL in db/schema.ts. Fail-soft throughout.

export interface RolloverSyncDeps {
  db: Database;
  request: (
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  nowUnix?: number;
}

export async function syncContractRollovers(
  deps: RolloverSyncDeps,
): Promise<HelloSyncResult> {
  const nowUnix = deps.nowUnix ?? Math.floor(Date.now() / 1000);

  const del = deps.db.prepare(`DELETE FROM contract_rollovers WHERE symbol = ?`);
  const insert = deps.db.prepare(
    `INSERT INTO contract_rollovers
       (symbol, contract_month, rollover_date, offset_points, was_edited, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return runHelloSync({
    label: "rollover-sync",
    requestType: "request_rollovers",
    items: Object.keys(REGISTRY),
    syncOne: async (symbol) => {
      const res = await deps.request("request_rollovers", { symbol });
      if (!isInboundType(res, "rollovers_response")) {
        const t = res && typeof res === "object" ? (res as { type?: unknown }).type : res;
        throw new Error(`unexpected reply type: ${String(t)}`);
      }

      // NT8 answers success-with-zero-rows for both "no table" (fresh
      // install) and a genuinely empty one. Wiping a good mirror on that would
      // silently disarm the lake splice's roll guard, so keep and fail loudly.
      if (res.rollovers.length === 0) {
        const kept = deps.db
          .prepare(`SELECT COUNT(*) AS n FROM contract_rollovers WHERE symbol = ?`)
          .get(symbol) as { n: number };
        throw new Error(
          `NT8 returned 0 rollovers — keeping the existing mirror (${kept.n} row(s)). ` +
            "If the platform's table is truly empty, clear contract_rollovers for this " +
            "symbol manually.",
        );
      }

      // Full replace, not upsert: NT8 deletes rows too, and one that vanished
      // upstream would survive here as a phantom roll boundary.
      deps.db.transaction(() => {
        del.run(symbol);
        for (const r of res.rollovers) {
          insert.run(symbol, r.contractMonth, r.rolloverDate, r.offset, r.wasEdited ? 1 : 0, nowUnix);
        }
      })();

      console.error(
        `[rollover-sync] ${symbol}: ${res.rollovers.length} rollover(s), ` +
          `mergePolicy=${res.mergePolicy || "unknown"} priceBasis=${res.priceBasis || "unknown"}`,
      );
    },
  });
}

/** Kick a sync whenever NT8 (re)connects. */
export function registerRolloverSyncOnHello(): void {
  registerHelloSync("rollover-sync", () =>
    syncContractRollovers({ db: defaultDb, request: bridgeRequest }),
  );
}
