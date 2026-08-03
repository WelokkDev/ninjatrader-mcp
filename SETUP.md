# Setup

> This walkthrough is addressed to the AI agent (Claude or otherwise) helping a
> user set up this repo. If you're reading it yourself: it works the same, just
> type the commands.

Goal: a working MCP server with a live NinjaTrader 8 bridge, real candles in the
cache, and a drawing on a chart. Follow the steps in order — each one is
verifiable before moving on.

**Two steps belong to the human, not the agent.** Copying the C# files into the
NinjaTrader installation and compiling them in the NinjaScript Editor are the
developer's own hands. An agent must not write into `Documents/NinjaTrader 8/bin/Custom/`
— it's the user's trading platform, the compile is a GUI action, and a stray
file there is theirs to live with. The agent prepares everything else, hands off
with exact instructions, and verifies the result afterward.

---

## 1. Prerequisites

- **Windows** with **NinjaTrader 8** installed. (The MCP server itself is
  cross-platform, but the bridge talks to NT8, which is Windows-only.)
- **Node.js 20, 22, 23, 24, or 25.** The repo declares no `engines` field, but
  it depends on `better-sqlite3@^12.8.0`, which declares
  `node: 20.x || 22.x || 23.x || 24.x || 25.x`. Check with `node -v`.
- **An MCP client** (e.g. Claude Code) that can run a local stdio server.

`better-sqlite3` is a native module. Its install script is
`prebuild-install || node-gyp rebuild --release` — on a supported Node version it
downloads a prebuilt binary and needs no compiler. If `npm install` starts
invoking `node-gyp`, your Node version has no prebuild for it: switch to a
supported Node version rather than installing Visual Studio Build Tools.

## 2. Install and build

```
npm install
npm run build
```

`npm run build` is private-free — it runs `tsc` and then a private-module build
that **exits silently when `src/private/` is absent**. A fresh clone builds
cleanly. (If you've read an older claim that the build requires `src/private/`,
it's stale.)

Verify: `build/index.js` exists.

## 3. First run — the database and your token

There is **no database setup step**. Opening the connection creates everything:
`src/db/connection.ts` runs `mkdirSync` on the data directory, opens
`data/candles.db` in WAL mode, and calls `initializeSchema`, which creates all
nine tables (`candles`, `draw_commands`, `session_calendar`,
`live_subscriptions`, `live_position_feed`, `backtest_runs`, `trades`,
`trade_decisions`, `positions`) plus indexes. Every statement is
`CREATE TABLE IF NOT EXISTS` and the column migrations are idempotent, so this
runs safely on every boot. Nothing to create by hand, ever.

The server is registered in `.mcp.json` already:

```json
{
  "mcpServers": {
    "ninjatrader": {
      "command": "node",
      "args": ["./scripts/mcp-entry.mjs"],
      "timeout": 1800000
    }
  }
}
```

`scripts/mcp-entry.mjs` boots `build/private/index.js` when a private module has
been built, otherwise `build/index.js` — so this needs no per-user editing.

**Run exactly one server process.** Whichever process starts first owns the
bridge port and the candle cache; a second one finds the port taken and runs
bridge-disabled. If your MCP client is already running the server, don't also
run `npm start`.

To create the database and token before wiring up the client, run the server
once and stop it:

```
npm start
```

On the very first run it prints to **stderr**:

```
[bridge] generated new token; wrote <repo>\.env.local
[bridge] paste this into the NT addon config: <64 hex chars>
```

Those two lines appear **once, ever**. Every later run prints
`[bridge] using token from <repo>\.env.local` instead. Don't rely on catching
them — MCP clients usually swallow the server's stderr. The token is persisted,
so read it from the file instead:

```
<repo>/.env.local     →     NT_BRIDGE_TOKEN=<64 hex chars>
```

You should also see `[bridge] listening on 127.0.0.1:9472`. The bridge binds
**loopback only** — nothing reaches it from the network.

> **Agent:** `.env.local` is the source of truth for the token. Read
> `NT_BRIDGE_TOKEN` from it rather than asking the user to copy a value out of a
> log they probably never saw.

### Write the NT8 bridge config

The AddOn reads its config from `Globals.UserDataDir` — normally
`C:\Users\<you>\Documents\NinjaTrader 8\bridge.config.json`. Note that's the
**root** of the NT8 user data directory, not `bin/Custom/`.

Create it with the token from `.env.local`:

```json
{ "token": "<the 64-hex value of NT_BRIDGE_TOKEN>", "url": "ws://127.0.0.1:9472" }
```

Both keys are required and must be non-empty. The AddOn re-reads this file every
5 seconds while disconnected, so **creating or fixing it never requires an NT8
restart** — it's picked up within about 5s.

If the user's NT8 stores its data elsewhere, don't guess the path: the AddOn
prints the exact path it looked at (see step 5).

## 4. The NinjaTrader side — the developer does this

> **Hand this section to the user. Don't do it for them.**

**Copy two files** from this repo into your NinjaTrader installation:

| From (this repo) | To |
|---|---|
| `ninja-addon/addons/mcp-bridge.cs` | `Documents\NinjaTrader 8\bin\Custom\AddOns\` |
| `ninja-addon/indicators/mcp-renderer.cs` | `Documents\NinjaTrader 8\bin\Custom\Indicators\` |

`ninja-addon/indicators/mcp-sma-snapshot.cs` is an optional R&D tool (it writes
SMA parity snapshots for offline comparison). **Skip it** — it's not part of a
working setup.

**Then, in NinjaTrader:**

1. Open the NinjaScript Editor (**New → NinjaScript Editor**).
2. Compile (**F5**, or right-click → Compile). Both files must compile clean.
3. The AddOn loads automatically once compiled — there is no enable checkbox.
4. Open the NinjaScript Output window (**New → NinjaScript Output**) and stay on
   **Tab 1**. Everything below prints there.
5. Attach the **`McpBridgeRenderer`** indicator to every chart the server should
   draw on (right-click chart → Indicators → `McpBridgeRenderer`). Attaching is
   what registers that chart's symbol with the AddOn — without it, the server
   cannot draw on that chart.

**Trading Hours templates.** The AddOn maps onto two stock NT8 templates that
must exist under **Tools → Trading Hours**:

- `CME US Index Futures ETH` (for ES, NQ, YM, RTY, MES, MNQ, MYM, M2K)
- `Nymex Metals - Energy ETH` (for CL and GC — NT8 ships one combined template)

These ship with NT8. If yours are named differently, step 5 will tell you.

## 5. Verify the connection

This is the real check, and it's the whole reason for the Output window. On
**Output Tab 1** you should see, in order:

```
[McpBridge] [startup] Available NT8 TradingHours templates: 'CME US Index Futures ETH' ...
[McpBridge] [startup] verified mapping: cme_us_index_futures_eth → 'CME US Index Futures ETH' (exists in NT8)
[McpBridge] connecting to ws://127.0.0.1:9472
[McpBridge] connected
[McpBridge] sent hello (1 instruments)
[McpBridge] hello_ack: serverVersion=0.1.0
```

`hello_ack` is the one that matters — it means the token was accepted and the
round trip works. `sent hello (N instruments)` counts charts with the renderer
attached, and attaching one also prints
`[McpBridge] indicator registered symbol: NQ 09-26`.

**Heartbeats are silent on the happy path.** The AddOn beats every 10s and prints
nothing. Seeing no heartbeat output is correct — don't read it as a problem.

Server-side (stderr), the same handshake looks like:

```
[bridge] listening on 127.0.0.1:9472
[bridge] client connected
[bridge] hello received: NT NT8, instruments=[NQ 09-26]
```

(`NT NT8` is literal — the AddOn hardcodes its version string.)

A **template warning** at startup is worth stopping for:

```
[McpBridge] [startup] WARNING: mapping target NOT FOUND in NT8: nymex_energy_eth → 'Nymex Metals - Energy ETH' — fix TRADING_HOURS_MAP in mcp-bridge.cs
```

The AddOn **fails closed** on candle requests for that template — it never
silently falls back to RTH, which would hand you wrong data. If the warning names
a template you care about, fix `TRADING_HOURS_MAP` in `mcp-bridge.cs` to match
your install's actual name and recompile. A warning for a template you don't
trade (e.g. metals) is harmless.

## 6. Warm the candle cache

Requires NT8 connected — prefetch rejects the job otherwise with
`NinjaTrader is not connected — start NT8 with the McpBridge addon, then retry.`

Restart your MCP client so it picks up the server, then:

1. **`resolve_session_days`** — pure calendar math, fetches nothing. Use it to
   turn a date range or an anchor (`today`, `last-week`, `last-n-sessions`) into
   exact session days and expected bar counts. Check the shape of what you're
   about to pull.
2. **`prefetch_candles`** — the right way to pull history. It returns instantly
   with `{jobId, daysTotal, alreadyComplete, expectedBarsToFetch}` and ingests in
   the background, one NT8 request at a time, verifying each day against the
   cache. Already-complete days are skipped, so re-issuing the same call resumes
   rather than redoing work. All four args are required:

   | Arg | Value |
   |---|---|
   | `symbol` | ES, NQ, YM, RTY, MES, MNQ, MYM, M2K, CL, GC |
   | `timeframe` | `1s`, `5s`, `15s`, `5m`, `15m` or `1d` — the raw streams NT8 serves. `15m` also rebuilds derived 30m/1h/2h/4h; the rest are parallel streams. The sub-minute ones are dense (up to ~82,800 buckets/day at `1s`) and slow to fill — prefetch them a few days at a time. |
   | `start` | `YYYY-MM-DD` session day (close-date convention) |
   | `end` | `YYYY-MM-DD`, inclusive |

3. **`prefetch_status`** — call it with no `jobId` to list recent jobs. **Do
   check it**: this is how you catch days that failed instead of assuming the
   pull was clean. Jobs live in server memory and don't survive a restart.
4. **`get_candles`** — read the range back. It's fail-closed: if the expected bar
   count exceeds `limit` (default 500) it refuses rather than truncating, and
   every response reports expected vs. actual counts with per-day validation.

The **session calendar needs no manual step**. A small bootstrap set of
2026–2027 CME holidays is inserted offline, and on every NT8 `hello` the server
syncs full holiday/early-close calendars for each registered template. Sync
failures are logged and never break the connection.

**Offline alternative:** `npm run seed` loads the two tracked fixtures
(`data/sample/ES_15m.csv`, `NQ_15m.csv`) into the cache and derives the higher
timeframes — no NT8 required. It runs `build/scripts/seed.js` directly, so
**build first**. It's ES/NQ 15m only: useful to prove the cache works, not a
substitute for real history.

## 7. Smoke test — draw on a chart

With `McpBridgeRenderer` attached to a chart, call `draw`:

```json
{
  "id": "smoke-1",
  "symbol": "NQ",
  "shape": { "kind": "hline", "price": 20000 },
  "style": { "color": "#00ff00", "label": "hello from MCP" }
}
```

The line should appear on the chart. Then `clear_zones` with the same `id` (or no
`id` to clear all) removes it.

Drawings survive chart reloads: the AddOn retains draw commands per symbol and
the renderer replays them when the data series reloads. All drawing tools fail
closed with a clear message when NT8 isn't connected — if `draw` reports that,
go back to step 5.

Other shapes: `rectangle` (`proximal`, `distal`), `vline` (`ts`), `text` (`ts`,
`price`, `text`). Timestamps are unix **seconds**.

## 8. Optional — live bar feed

Stream closed bars from NT8 into the candle cache as they happen, instead of
fetching after the fact. Requires the AddOn from step 4 to have been compiled
from a source tree that includes `subscribe_bars` (recompile after updating
`ninja-addon/addons/mcp-bridge.cs` if unsure — a subscribe that times out with
a "recompile" hint means the AddOn predates it).

Start a stream and check it:

```
subscribe_live_bars { "symbol": "MNQ", "timeframe": "5m" }
live_feed_status {}
```

`subscribe_live_bars` answers with the truth from NT8 — `acked: true` plus the
resolved contract (e.g. `MNQ 09-26`) — not just "message sent". After the next
5m boundary, `live_feed_status` shows the bar count and lag (expect ≤ ~2 s
during RTH), and `get_candles` serves the bar from the cache immediately.
Higher timeframes (30m–4h) derive automatically on 15m closes; `15s`, `5s` and
`1s` work but are subscribe-on-demand only (seconds history is shallow
provider-side, and shallower the finer the timeframe).

Subscriptions persist across server restarts and replay whenever NT8
reconnects; missed bars are healed automatically through `request_candles`
(visible as `gapCount` in `live_feed_status`).

**For bots and dashboards** there is a push channel on the same port:
`ws://127.0.0.1:9472/feed`, authenticated with the same bearer token. A minimal
Python consumer ships in the repo:

```bash
pip install websockets
python examples/python/live_feed_client.py MNQ 5m
```

Subscribing on `/feed` creates the upstream NT8 stream too, so a bot is
self-sufficient. Bars tagged `backfill: true` closed well before delivery
(reconnect catch-up) — act-on-close logic must skip them.

## 9. Optional — live position tracking

Strictly **read-only** observation of your accounts — the bridge never places,
changes, or cancels orders. Requires the AddOn to have been compiled from a
source tree that includes `subscribe_positions` (a request that times out with
a "recompile" hint means it predates the feature).

Check what's open right now (works with or without the feed):

```
get_positions {}
```

Every position comes back with the account it belongs to (sim vs. live is
flagged by name heuristic and never merged), average entry, working stops and
targets matched into dollar risk and an R-multiple, and unrealized P&L computed
from the freshest price the server knows — the answer says which price source
it used and how old it is. When NT8 is disconnected the reply is marked
`stale: true` with a warning: treat it as *unknown*, never as flat.

Turn on the event feed for live-trade context:

```
subscribe_live_positions {}
```

While on, the AddOn streams fills, order changes, and position transitions
(sparse events — not a P&L ticker), and pushes a full snapshot on subscribe,
provider reconnect, and account changes so state self-heals. `get_positions`
then also carries per-trade age, fill history, and MAE/MFE — excursion
granularity follows whatever live bar feeds are running (a sub-minute bar sub
on the traded symbol gives the finest picture — `1s` the finest of all). The toggle persists across server
restarts and replays on every NT8 reconnect. Health lives in
`live_feed_status` under `positions`; events also broadcast on the `/feed`
channel (send `{"type": "subscribe_positions"}`).

## 10. Optional — trade import

Skip this entirely if you only want candles and drawing. Nothing else depends on
it.

`get_trades` and `sync_trades` read NinjaTrader's own database directly — no
bridge involved. The config is loaded **lazily**, only when one of those two
tools is actually called. Both tools appear in the tool list without it and
simply return `loadNinjaTraderConfig: cannot read ...` when called. That error is
expected on a candles-only setup, not a sign of a broken install.

Copy the tracked example to create your config in the **repo root** (override the
location with `NT_TRADES_CONFIG`):

```
cp ninjatrader.config.example.json ninjatrader.config.json
```

Then edit `dbPath` to your real path:

```json
{
  "dbPath": "C:/Users/YOUR_NAME/Documents/NinjaTrader 8/db/NinjaTrader.sqlite"
}
```

**Use forward slashes.** They work fine on Windows and dodge the most common
mistake here — a Windows path pasted into JSON with unescaped backslashes, which
fails as `failed to parse config`. If you do use backslashes, double them (`\\`).

`ninjatrader.config.json` is gitignored; the `.example.json` is tracked. Keep it
that way — your config holds a local filesystem path and possibly an account name.

**`dbPath`** is the only required key. **`account`** is optional: add it to
restrict the import to a single NinjaTrader account.

```json
{
  "dbPath": "C:/Users/YOUR_NAME/Documents/NinjaTrader 8/db/NinjaTrader.sqlite",
  "account": "Sim101"
}
```

The example deliberately omits `account`, because leaving it out imports **all**
accounts — the safe default. Only add it once you know the exact account name as
NinjaTrader spells it: the filter is an exact SQL match and a typo returns zero
trades **silently**, with no error.

**Finding `NinjaTrader.sqlite` — two traps:**

- **OneDrive.** If the user's Documents folder is redirected to OneDrive, the
  real path is `C:\Users\<you>\OneDrive\Documents\NinjaTrader 8\db\...` and the
  literal `C:\Users\<you>\Documents\...` **does not exist**. There is no path
  discovery in the code — `dbPath` is used verbatim, and a wrong path surfaces as
  a raw `ENOENT: no such file or directory, copyfile ...`. Check both locations.
- **Backup files.** That directory often also holds machine-suffixed copies like
  `NinjaTrader-DESKTOP-XXXX.sqlite`. Use the plain, un-suffixed
  `NinjaTrader.sqlite`.

**You do not need to close NinjaTrader.** The importer copies the database (plus
its `-wal`/`-shm` siblings) to a temp snapshot, integrity-checks the copy, and
opens it read-only. It never opens the live file read-write; a test enforces the
source is byte-identical afterward.

**Verify with `sync_trades`** (`from`, `to` as unix seconds), not `get_trades` —
it always attempts an ingest, returns the diagnostic `{fetched, inserted}`, and
surfaces errors directly instead of swallowing them. Reading the result:

- `fetched > 0, inserted > 0` — the whole chain works.
- `inserted: 0` on a **re-run** is correct. Inserts dedupe on
  `(source, external_id)`, so re-syncing is idempotent.
- `fetched > 0, inserted: 0` on a **first** run usually means the range held only
  open positions — only closed round trips are imported.
- `fetched: 0` with a configured `account` — the account filter is an exact SQL
  match and yields zero rows **silently** on a typo. Check the name in NT8.

Then read them back with `get_trades` or `list_trades`.

## 11. Troubleshooting

| What you see | What it means |
|---|---|
| `[McpBridge] config not found at <path> — create it with {"token":"...","url":"ws://127.0.0.1:9472"}` | No `bridge.config.json`. **The path in this message is authoritative** — create the file exactly there, whatever the docs say. Picked up within ~5s. |
| `[McpBridge] config at <path> missing token or url` | File parsed, but a key is absent or empty. Both are required. |
| `[McpBridge] failed to parse config: ...` | Invalid JSON. Watch for unescaped backslashes. |
| `[McpBridge] connection error: ...` then `reconnecting in 1000ms`, `2000ms`, `4000ms`… | Generic .NET connect failure, backing off 1s→30s. Cross-check the server's stderr for the real reason — the two rows below. |
| `[bridge] rejected upgrade: bad or missing token` (server) | Token mismatch. Re-copy `NT_BRIDGE_TOKEN` from `.env.local` into `bridge.config.json`. |
| `[bridge] rejected upgrade: client already connected` (server) | A second NT8/client is already on the bridge. Only one at a time. |
| `[bridge] WARNING: failed to start on port 9472 (listen EADDRINUSE ...); bridge disabled, MCP continuing` | **Two server processes.** Classic cause: the MCP client started one and you also ran `npm start`. Kill one. The MCP server keeps running cache-only. |
| `[bridge] WARNING: invalid NT_BRIDGE_PORT (x); bridge disabled` | Port is NaN, ≤ 0, or > 65535. The MCP server still runs, cache-only. |
| `[bridge] heartbeat timeout (30123ms) — closing socket` | 30s of silence from NT8. It'll reconnect on its own. |
| `[McpBridge] [startup] WARNING: mapping target NOT FOUND in NT8: ...` | A Trading Hours template name doesn't match this install. Candle requests for it fail closed. See step 5. |
| `NT8 has no TradingHours template named '...'` | Same root cause, hit at request time. |
| `Unsupported timeframe: 'x'. Supported raw TFs: …` | Only the raw TFs (`1s`, `5s`, `15s`, `5m`, `15m`, `1d`) are fetched raw; 30m–4h are derived from 15m. The message lists the AddOn's own set — if it is missing `1s`/`5s`, the AddOn predates them and needs a recompile. |
| `NinjaTrader is not connected — start NT8 with the McpBridge addon, then retry.` | Prefetch with no bridge client. Work back through step 5. |
| Tool list is missing tools after a rebuild | Restart the MCP client — the tool list is read at startup. |

**A bridge failure is never fatal.** Every failure path warns and continues; the
MCP server runs cache-only against whatever is already in `candles.db`.

**`.env.local` is not a dotenv file.** There's no `dotenv` in this repo — the
hand-rolled reader looks for `NT_BRIDGE_TOKEN` and nothing else. Putting
`NT_BRIDGE_PORT` (or any other variable) in `.env.local` is **silently ignored**;
it has to be a real process environment variable.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `NT_BRIDGE_TOKEN` | generated into `.env.local` on first run | Shared secret with the AddOn. Set in the real env to override the file. |
| `NT_BRIDGE_PORT` | `9472` | Loopback bridge port. Invalid value disables the bridge, not the server. |
| `NT_DATA_PATH` | `<repo>/data` | Where `candles.db` lives. Note it does **not** move `data/sample/` or `backtest-results/`, which stay repo-relative. |
| `NT_TRADES_CONFIG` | `<repo>/ninjatrader.config.json` | Trade-import config path. Relative values resolve against the process cwd. |

## 12. Next steps

You now have the public tool surface: `get_candles`, `resolve_session_days`,
`prefetch_candles` / `prefetch_status` / `prefetch_cancel`, `draw`,
`clear_zones`, `list_trades`, `list_decisions`, `get_trades`, `sync_trades`.

The trading logic — zone detection, decision engines, strategies — is
deliberately not here. It lives in your own gitignored `src/private/` module,
composed on top of this substrate. `data/lab.db` and the experiment tools
(`start_experiment` and friends) likewise only appear once you've bound a Lab to
your own backtest engine; the public server doesn't create `lab.db` at all.

To build your own: **[BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md)**.
