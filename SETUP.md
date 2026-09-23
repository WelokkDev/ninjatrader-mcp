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

`scripts/mcp-entry.mjs` picks `build/private/index.js` when a private module has
been built, otherwise `build/index.js` — so this needs no per-user editing.

**One hub, any number of conversations.** The process the MCP client starts is
a thin *shim*: it attaches to the one **hub** on this machine over loopback
HTTP (`127.0.0.1:9474`) and starts the hub itself if none is running. The hub
owns the bridge port, the candle cache and the live feeds; every conversation
gets its own session inside it, so a second (or fifth) conversation sees NT8
exactly like the first. A hub the shims started exits about 90s after the last
conversation leaves; `npm start` runs one that stays up all day. `npm run
status` shows the hub and its sessions, `npm stop` stops it.

To create the database and token before wiring up the client, start the hub
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
them — a hub the shim started logs to `data/hub.log`, not to the MCP client.
The token is persisted, so read it from the file instead:

```
<repo>/.env.local     →     NT_BRIDGE_TOKEN=<64 hex chars>
```

You should also see `[hub] … listening on 127.0.0.1:9474` and
`[bridge] listening on 127.0.0.1:9472`. Both bind **loopback only** — nothing
reaches them from the network — and both require a token from `.env.local`
(`NT_HUB_TOKEN` is minted alongside the bridge token).

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

`ninja-addon/addons/feed-watchdog.cs` is optional and standalone, connection
alerts that keep working when everything else here is down. See step 11.

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

### Vendor history (Databento) — not into this cache

NT8 only retains about a year of tick data, and second-based bars are built from
it, so a deeper `1s`/`5s` history still has to come from outside. It just does
not come in *here*.

**`data/candles.db` is the NT8 store, and only the NT8 store.** Vendor bars
belong in a separate Parquet bar lake, and the two never mix in one table: the
two sources roll contracts on different dates, so a range crossing a roll would
hold different contracts depending on which rows happened to answer, with
nothing in the response to say so. The old `npm run import-databento` /
`npm run verify-import` pair wrote `source='databento'` rows straight into the
cache — the exact thing that rule forbids — and has been removed.

The bar lake and its ingest live in the **private module**, not in this repo (a
fresh public clone has no lake and needs none — NT8 fills the cache). If you
have a private module, the way in is `src/private/py/scripts/ingest_lake.py`.
Session geometry is TS-owned and handed to Python as data, so it takes a
resolved session-day envelope rather than computing one:

```
npm run build   # session-envelope.mjs reads the compiled session resolver

node src/private/scripts/session-envelope.mjs \
  --symbol MNQ --from 2024-01-02 --to 2026-08-13 --out src/private/py/mnq-days.json

cd src/private/py && uv run --no-sync python scripts/ingest_lake.py \
  --archive path/to/x.ohlcv-1s.dbn.zst --session mnq-days.json \
  --symbol MNQ --timeframe 1s --dry-run
```

Request the batch with `schema=ohlcv-1s` and a parent symbol (`MNQ.FUT`); the
ingest keeps outright contracts only and picks a **volume-ranked front month per
session-day, without back-adjusting** — ranked on the *previous* day's volume,
so a roll day carries no lookahead. Drop `--dry-run` to write. It writes one
Parquet partition per session-day and then derives the resample ladder; re-runs
replace whole partitions, so repeating one is safe.

What stays in this repo is the read-only inspector. It never writes anywhere:

```
.venv-tools/Scripts/python scripts/inspect-dbn.py path/to/x.ohlcv-1s.dbn.zst
```

It prints the file's metadata, its `instrument_id -> raw_symbol` map and a
per-contract per-day volume profile, and re-checks the two conversion
assumptions any importer depends on — `ts_event` is the interval **start** in
nanoseconds on an exact second boundary, and prices are int64 fixed-point at
1e-9. (That first one is the classic silent bug: this cache is close-stamped, so
an ingest that forgets to add a period lands every bar one period early, nothing
errors, and backtests read the future.)

It needs a one-time `python -m venv .venv-tools && .venv-tools/Scripts/pip
install databento`. Deliberately its own venv, not `src/private/py/.venv` —
public commands must not depend on the private module.

If an older import left vendor rows in your cache, `node
build/scripts/evict-vendor-rows.js` reports them (`--confirm` deletes and
VACUUMs). Run it only *after* the same range is in the lake and verified there:
it cannot see the lake, and deliberately does not pretend to.

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
simply return `loadNinjaTraderConfig: cannot read ..., and NT_TRADES_DB_PATH is
not set` when called. That error is expected on a candles-only setup, not a sign
of a broken install.

There are two ways to point it at your database. **Prefer `.env.local`** — the
path is per-machine, and that file is already the gitignored home for such
values, so one checkout can serve several machines with nothing machine-specific
in the tracked tree:

```
NT_TRADES_DB_PATH=/Users/YOUR_NAME/Documents/NinjaTrader 8/db/NinjaTrader.sqlite
```

Add `NT_TRADES_ACCOUNT=Sim101` beside it to restrict the import to one account.
A path with spaces works as written; quotes are optional and stripped, so quote
it if you also `source` this file from a shell. No JSON config file is required
at all.

The older route still works and is unchanged — copy the tracked example to
create a config in the **repo root** (override the location with
`NT_TRADES_CONFIG`):

```
cp ninjatrader.config.example.json ninjatrader.config.json
```

Then edit `dbPath` to your real path:

```json
{
  "dbPath": "C:/Users/YOUR_NAME/Documents/NinjaTrader 8/db/NinjaTrader.sqlite"
}
```

`NT_TRADES_DB_PATH` wins when both are present.

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

## 11. Optional — connection alerts

Skip this if you never leave anything running unattended. It watches the Control
Center connection light and tells you when it leaves green — in the Output
window, and optionally on Discord.

It is **standalone on purpose**: it shares no state with `McpBridge`, so it keeps
reporting when the MCP server, the `/feed` socket, or your runner are down, which
is exactly when you want to hear from it. It never touches orders.

"Green" is not one flag. NT8 carries two independent statuses per connection —
`Status` (orders/brokerage) and `PriceStatus` (market data) — and the light is
green only when **both** are Connected — though a half that has never connected
at all does not count against it, see the table below. The asymmetric case,
orders fine but data dead, is the one that runs a strategy on a feed that
stopped; nothing else in this repo reads `PriceStatus`.

**Copy and compile** — the developer's own hands, exactly as in step 4:

| From (this repo) | To |
|---|---|
| `ninja-addon/addons/feed-watchdog.cs` | `Documents\NinjaTrader 8\bin\Custom\AddOns\` |

Compile with **F5**. It loads automatically — there is no enable checkbox.

### Write the watchdog config

Optional. Without it the AddOn logs to the Output window only, and says so at
startup. Same directory as `bridge.config.json` — the **root** of the NT8 user
data directory, not `bin/Custom/`:

```
C:\Users\<you>\Documents\NinjaTrader 8\feed-watchdog.config.json
```

```json
{
  "webhook": "https://discord.com/api/webhooks/...",
  "ignore": ["Playback Connection", "Simulated Data Feed"]
}
```

| Key | Required | Purpose |
|---|---|---|
| `webhook` | no | Discord webhook URL. Omit for Output-window-only. |
| `ignore` | no | Connection names to skip entirely, case-insensitive. Rarely needed — a connection that has never come up reads as IDLE on its own, so Playback and unused providers stay quiet without being listed. Use it for anything you want out of the picture regardless. |

Unlike `bridge.config.json`, this file is read **once at startup** — changing it
needs an NT8 restart.

### What you should see

About 16 seconds after NT8 starts, one baseline line per connection and **no
Discord message**:

```
[FeedWatchdog] started — alerts to Discord + this window
[FeedWatchdog] baseline — Rithmic — data:Connected orders:Connected
```

After that it speaks only on change:

| Light | Meaning | When it alerts |
|---|---|---|
| 🟢 GREEN | every half that has ever been up is Connected | on recovery from a reported outage — never at startup |
| ⚪ IDLE | no half has ever connected this session — Playback, an unused provider | never; logged once and that is all |
| 🟠 ORANGE | a half still negotiating | only if it holds ~45s, so a slow connect or a blip stays quiet |
| 🔴 RED | `ConnectionLost` on either half, **or** `Disconnected` on a half that had been up | immediately, every time, first pass included |

NT8 reports `Disconnected` both for "this dropped" and for "you never used
this", so the AddOn tracks, per half, whether it has ever been Connected in this
session. That flag is sticky: the moment a half has been up, a later
`Disconnected` on it is a drop and reads RED. An order-only connection whose
price half never connects therefore reads GREEN rather than nagging, without
blinding the watchdog to that same half dying later.

A connection already down when NT8 starts alerts on that first pass: the startup
quiet window suppresses baselines and unsettled states, never RED.

## 12. Troubleshooting

| What you see | What it means |
|---|---|
| `[McpBridge] config not found at <path> — create it with {"token":"...","url":"ws://127.0.0.1:9472"}` | No `bridge.config.json`. **The path in this message is authoritative** — create the file exactly there, whatever the docs say. Picked up within ~5s. |
| `[McpBridge] config at <path> missing token or url` | File parsed, but a key is absent or empty. Both are required. |
| `[McpBridge] failed to parse config: ...` | Invalid JSON. Watch for unescaped backslashes. |
| `[McpBridge] connection error: ...` then `reconnecting in 1000ms`, `2000ms`, `4000ms`… | Generic .NET connect failure, backing off 1s→30s. Cross-check the server's stderr for the real reason — the two rows below. |
| `[bridge] rejected upgrade: bad or missing token` (server) | Token mismatch. Re-copy `NT_BRIDGE_TOKEN` from `.env.local` into `bridge.config.json`. |
| `[bridge] rejected upgrade: client already connected` (server) | A second NT8/client is already on the bridge. Only one at a time. |
| `[bridge] WARNING: failed to start on port 9472 (listen EADDRINUSE ...); bridge disabled, MCP continuing` | **Two processes want the bridge port.** With the hub layout that means an in-process server (`--stdio` / `NT_NO_HUB=1`, or a pre-hub build) is running next to the hub. `npm run status` shows the hub; stop the stray. The loser keeps running cache-only. |
| `[hub] another hub already owns 127.0.0.1:9474; exiting` | Two conversations started at the same instant and both spawned a hub; the loser exits at once and both attach to the winner. Harmless. |
| `[shim] WARNING: the hub (pid …) runs a build from … but the build on disk is from …` | You rebuilt while a hub was running. **Every conversation is still on the old code** until the hub restarts: `npm stop`, then reconnect the client (`/mcp` in Claude Code). |
| `the hub did not come up within 30s; see data/hub.log` | The spawned hub crashed or hung at startup. The log has the reason. |
| `the hub at … rejected this process's NT_HUB_TOKEN` | The shim and the hub read different `.env.local` files, or an env override disagrees. `npm stop`, fix the token, reconnect. |
| `[bridge] WARNING: invalid NT_BRIDGE_PORT (x); bridge disabled` | Port is NaN, ≤ 0, or > 65535. The MCP server still runs, cache-only. |
| `something other than a hub answers on http://127.0.0.1:9474 (HTTP …)` | Another local service (a dashboard, say) owns the hub's port. Put `NT_HUB_PORT=<free port>` in `.env.local`; every shim and the hub read it. |
| `[bridge] heartbeat timeout (30123ms) — closing socket` | 30s of silence from NT8. It'll reconnect on its own. |
| `[McpBridge] [startup] WARNING: mapping target NOT FOUND in NT8: ...` | A Trading Hours template name doesn't match this install. Candle requests for it fail closed. See step 5. |
| `NT8 has no TradingHours template named '...'` | Same root cause, hit at request time. |
| `Unsupported timeframe: 'x'. Supported raw TFs: …` | Only the raw TFs (`1s`, `5s`, `15s`, `5m`, `15m`, `1d`) are fetched raw; 30m–4h are derived from 15m. The message lists the AddOn's own set — if it is missing `1s`/`5s`, the AddOn predates them and needs a recompile. |
| `NinjaTrader is not connected — start NT8 with the McpBridge addon, then retry.` | Prefetch with no bridge client. Work back through step 5. |
| Tool list is missing tools after a rebuild | Stop the hub (`npm stop`) and reconnect the client — a running hub keeps serving the code it started with. |

**A bridge failure is never fatal.** Every failure path warns and continues; the
MCP server runs cache-only against whatever is already in `candles.db`.

**`.env.local` is not a dotenv file.** There's no `dotenv` in this repo and
nothing is injected into `process.env`. The hand-rolled reader consults a fixed
set of keys — the bridge (`NT_BRIDGE_*`), the hub (`NT_HUB_*`), trade import
(`NT_TRADES_DB_PATH`, `NT_TRADES_ACCOUNT`) and the order gate (`NT_TRADING_*`)
— and ignores everything else, so putting any *other* variable there does
nothing. Real process env always wins over the file.

Because it's gitignored, `.env.local` is the right home for anything
machine-specific: one checkout can serve a Windows box running NT8 locally
(no host line, loopback default) and a Mac running NT8 in a VM
(`NT_BRIDGE_HOST=10.211.55.2`) with **no difference in the tracked tree** — do
not put these in `.mcp.json`, which is tracked and shared between your
machines.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `NT_BRIDGE_TOKEN` | generated into `.env.local` on first run | Shared secret with the AddOn. Set in the real env to override the file. |
| `NT_BRIDGE_PORT` | `9472` | Bridge port. Read from process env or `.env.local`. Invalid value disables the bridge, not the server. |
| `NT_BRIDGE_HOST` | `127.0.0.1` | Interface the bridge binds. Read from process env or `.env.local`. Only override to reach NT8 in a VM — see below. An unbindable address disables the bridge, not the server. |
| `NT_HUB_PORT` | `9474` | Port of the hub every conversation attaches to. Read from process env or `.env.local`. Always loopback; `NT_BRIDGE_HOST` does not apply to it. |
| `NT_HUB_TOKEN` | generated into `.env.local` on first run | Shared secret between the per-conversation shims and the hub. |
| `NT_NO_HUB` | unset | `1` makes the entry run the bin in-process for its one client (the pre-hub layout), same as `--stdio`. Useful with the MCP inspector. |
| `NT_DATA_PATH` | `<repo>/data` | Where `candles.db` lives. Note it does **not** move `data/sample/` or `backtest-results/`, which stay repo-relative. |
| `NT_TRADES_DB_PATH` | unset | Path to NT8's `NinjaTrader.sqlite`. Read from process env or `.env.local`. **Takes priority over the config file** — set this and no JSON config is needed. |
| `NT_TRADES_ACCOUNT` | unset | Optional account filter to pair with `NT_TRADES_DB_PATH`. Leave unset to import all accounts. |
| `NT_TRADES_CONFIG` | `<repo>/ninjatrader.config.json` | Trade-import config path. Relative values resolve against the process cwd. Only consulted when `NT_TRADES_DB_PATH` is unset. |

### Running NT8 in a VM (Parallels / VMware) with the server on the host

The server is cross-platform; only NT8 needs Windows. Running the server on a
macOS or Linux host with NT8 in a VM works, with two adjustments.

**1. The bridge has to bind an address the guest can reach.** By default it
binds `127.0.0.1`, which inside the guest means the *guest's* own loopback — the
AddOn will log `connecting to ws://127.0.0.1:9472` and back off forever. Bind the
hypervisor's host address instead, by adding a line to `.env.local` next to your
token:

```
NT_BRIDGE_HOST=10.211.55.2
```

That file is gitignored, so this stays local to the VM machine and a checkout on
a normal Windows box is untouched. It applies however the server is started —
your MCP client, `npm start`, anything — so there is nothing to configure in
`.mcp.json`.

Find the address on the host, not by guessing — on macOS with Parallels'
default **Shared** networking it's the `bridge100` inet address:

```
ifconfig | grep -A3 '^bridge1' | grep 'inet '
```

Typically `10.211.55.2` (Shared) and `10.37.129.2` (Host-Only). Both exist only
on the VM networks and are **not** routable from your LAN, so the bridge stays
off the network.

> Do **not** bind `0.0.0.0`. That publishes the bridge — and the `/feed`
> channel — to every network the host is on. If your VM uses **Bridged**
> networking there is no host-only address to bind; switch the VM to Shared
> rather than exposing the port to the LAN.

Then point the guest's `bridge.config.json` at it (step 3's file, same token):

```json
{ "token": "<NT_BRIDGE_TOKEN>", "url": "ws://10.211.55.2:9472" }
```

The host firewall will ask to allow incoming connections for `node` the first
time — allow it. Everything else on the NT8 side (step 4's copy + compile, the
renderer, Trading Hours templates) is unchanged. The bridge now crosses a
virtual NIC instead of loopback; latency stays sub-millisecond, well inside the
10s heartbeat / 30s timeout budget.

**2. Find out where NT8's user data dir really is before writing any path.**
This decides both `bridge.config.json` (step 3) and `dbPath` (step 10), and the
obvious guess is often wrong. Parallels' default **maps the guest's user folders
onto the Mac's** — so the guest's `Documents` is the host's `~/Documents`, and
`Globals.UserDataDir` resolves to a path that lives on the *host* disk:

```
guest:  C:\Mac\Home\Documents\NinjaTrader 8
host:   ~/Documents/NinjaTrader 8          # the same bytes
```

When that mapping is on, this is the easy case: `bridge.config.json` is written
with a normal host-side editor, and `dbPath` is a plain local path — no share,
no snapshot over SMB:

```json
{ "dbPath": "/Users/YOUR_NAME/Documents/NinjaTrader 8/db/NinjaTrader.sqlite" }
```

Confirm it in the guest rather than assuming, by reading the redirect target:

```
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" /v Personal
```

`C:\Mac\Home\Documents` means mapping is on. A plain
`C:\Users\<you>\Documents` means it's off, and the data dir genuinely lives
inside the guest — then you need the reverse share (Parallels: **Share Windows
→ Access Windows folders from Mac**) and a `dbPath` under that mount. The
importer's snapshot-copy does work over a share (it copies the `.sqlite` plus
its `-wal`/`-shm` siblings and integrity-checks the copy), just slower.

> **Agent:** run that query as the *logged-in user*. Tooling that executes in
> the guest as SYSTEM (e.g. `prlctl exec`) cannot traverse `C:\Mac` — the
> Parallels share is a per-user session mount — and will report an empty
> `C:\Users\<you>\Documents` placeholder, which reads as "NT8 was never
> launched" when in fact the real data dir is on the host and full.

---

## 13. Next steps

You now have the public tool surface: `get_candles`, `resolve_session_days`,
`prefetch_candles` / `prefetch_status` / `prefetch_cancel`, `draw`,
`clear_zones`, `list_trades`, `list_decisions`, `get_trades`, `sync_trades`.

The trading logic — zone detection, decision engines, strategies — is
deliberately not here. It lives in your own gitignored `src/private/` module,
composed on top of this substrate. `data/lab.db` and the experiment tools
(`start_experiment` and friends) likewise only appear once you've bound a Lab to
your own backtest engine; the public server doesn't create `lab.db` at all.

To build your own: **[BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md)**.
