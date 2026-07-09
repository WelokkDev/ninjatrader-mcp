import defaultDb from "./db/connection.js";
import { isConnected, request } from "./bridge/index.js";
import { PrefetchManager } from "./core/cache/prefetch.js";

// The single PrefetchManager the MCP server exposes — the one owner of
// all request_candles traffic (see core/cache/prefetch.ts).
export const prefetchManager = new PrefetchManager({
  db: defaultDb,
  isConnected,
  request,
});
