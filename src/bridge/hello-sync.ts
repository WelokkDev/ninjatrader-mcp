import { BridgeRequestError } from "./connection.js";
import { onMessage } from "./index.js";

// Shared scaffolding for the on-hello mirror syncs: serial, per-item failures
// isolated, bail on the FIRST timeout — an AddOn predating the request type
// never replies, so the rest would each burn a full timeout for the same
// answer. A wrong bail costs nothing; the next hello retries.

export interface HelloSyncResult {
  synced: number;
  failed: number;
}

export async function runHelloSync(opts: {
  /** Log prefix, e.g. "calendar-sync". */
  label: string;
  /** Named in the deploy-skew diagnosis when the AddOn never replies. */
  requestType: string;
  items: string[];
  /** Throw to count the item failed. */
  syncOne: (item: string) => Promise<void>;
}): Promise<HelloSyncResult> {
  let synced = 0;
  let failed = 0;

  for (let i = 0; i < opts.items.length; i++) {
    const item = opts.items[i];
    try {
      await opts.syncOne(item);
      synced++;
    } catch (err) {
      failed++;
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[${opts.label}] ${item} failed: ${m}`);
      if (err instanceof BridgeRequestError && err.kind === "timeout") {
        const remaining = opts.items.length - i - 1;
        failed += remaining;
        console.error(
          `[${opts.label}] no reply — the AddOn may predate ${opts.requestType}; ` +
            `skipping ${remaining} remaining item(s) this connection`,
        );
        break;
      }
    }
  }

  return { synced, failed };
}

/** Kick `run` on every NT8 (re)connect; failures log, never throw. */
export function registerHelloSync(label: string, run: () => Promise<unknown>): void {
  onMessage("hello", () => {
    void run().catch((err) => {
      console.error(`[${label}] unexpected failure:`, err);
    });
  });
}
