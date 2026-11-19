#!/usr/bin/env node

import { callHubTool } from "../hub/call.js";
import {
  connectFeedCallTimeoutMs,
  connectFeedExitCode,
  parseConnectFeedArgs,
} from "../tools/connect-feed-shared.js";

async function main(): Promise<number> {
  const args = parseConnectFeedArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    return 2;
  }
  let result;
  try {
    result = await callHubTool("connect_feed", { ...args }, {
      clientName: "connect-feed",
      timeoutMs: connectFeedCallTimeoutMs(args.timeoutSec),
    });
  } catch (err) {
    console.error(`connect-feed: could not call the hub: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const code = connectFeedExitCode(result);
  const print = code === 2 ? console.error : console.log;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (item && typeof item === "object" && item.type === "text") print(item.text);
  }
  return code;
}

process.exitCode = await main();
// A scheduler waits on this process, so a stray handle must not keep it alive.
setTimeout(() => process.exit(), 5_000).unref();
