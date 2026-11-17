import defaultDb from "./db/connection.js";
import { getAddonCaps, isConnected, request } from "./bridge/index.js";
import { frontContractFor } from "./core/cache/contracts.js";
import { envSetting } from "./core/env-local.js";
import { cacheReferenceBars, readCalendar } from "./nt8-lake/cache.js";
import { runLakeCli, TICK_LANE, TickFetchManager } from "./nt8-lake/fetch-job.js";
import { lakeRoot } from "./nt8-lake/layout.js";
import type { IngestReport, LakeContext, ProbeReport } from "./nt8-lake/ops.js";
import { prefetchManager } from "./prefetch-instance.js";

export const tickFetchManager = new TickFetchManager({
  // bridge request throws synchronously when disconnected; async makes it a rejection.
  request: async (type, payload, timeoutMs) => request(type, payload, timeoutMs),
  fetch: (type, payload, timeoutMs) => prefetchManager.backgroundRequest(TICK_LANE, type, payload, timeoutMs),
  isConnected,
  caps: getAddonCaps,
  dropPath: () => envSetting("NT_TICK_DROP_PATH"),
  lakeRoot,
  calendarFor: (name) => readCalendar(defaultDb, name),
  cacheFront: (symbol, label) => frontContractFor(defaultDb, symbol, label)?.contract ?? null,
  runIngest: (folder) => runLakeCli<IngestReport>(["ingest", "addon", folder]),
  runProbe: (folder) => runLakeCli<ProbeReport>(["probe", "addon", folder]),
});

/** The lake as the hub reads it: JSON files only, never DuckDB. */
export function hubLakeContext(): LakeContext {
  return {
    root: lakeRoot(),
    calendarFor: (name) => readCalendar(defaultDb, name),
    referenceBars: cacheReferenceBars(defaultDb),
  };
}
