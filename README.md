# ninjatrader-mcp

> **Status — a personal trading-research project under active development.** I use it daily and it's stable enough to lean on, but expect the odd sharp edge. It grew up tangled together with my own private trading methodology, and I've only recently pulled that apart so the public tools stand on their own. So remnants of my methodology — and of my own NinjaTrader 8 configuration — may still linger in field names, defaults, and validation, and could cause bugs on a setup unlike mine. I'm still working to decouple further and make things more flexible for other configurations and methodologies. Building your own strategy logic on top is a younger path — see [For algo developers: build your own](#for-algo-developers-build-your-own-optional) at the end.

**MCP tools for NinjaTrader 8.** This is a local MCP server that gives Claude hands-on access to your NinjaTrader 8 platform: pull session-day-aware futures candles, stream live bars and positions, draw levels and zones on your charts, and import your executed trades from NinjaTrader's own database. It runs locally over stdio and reaches NT8 through a loopback-only WebSocket bridge (a small NT8 AddOn) — nothing is exposed to the internet. It **works today with no code**: install it, compile the AddOn once, and start using the tools.

## Trade by hand? Start here — no code required

Install the server, compile the NT8 AddOn once (the only NinjaTrader-side step, and it's yours to do), then Claude can:

| What you want to do | Tools |
|---|---|
| **See the market** — OHLCV for any symbol / timeframe / session-day range, auto-filled from NT8, fail-closed on gaps | `get_candles`, `resolve_session_days`, `prefetch_candles` |
| **Watch it live** — closed bars and position / P&L / risk updates streamed as they happen | `subscribe_live_bars`, `live_feed_status`, `get_positions` |
| **Mark up your charts** — rectangles, horizontal & vertical lines, and text drawn onto the live NT8 chart | `draw`, `clear_zones`, `list_open_charts` |
| **Drive the chart** — "show me June 12th 9am": scroll any open chart to a date/time and zoom, no mouse required | `navigate_chart` |
| **Review your trading** — your real executed trades imported straight from NinjaTrader's database and paired into round trips | `get_trades`, `sync_trades` |

Everything above is **read-only or draw-only** — the bridge never touches your orders. **[SETUP.md](SETUP.md)** is the whole walkthrough: install → bridge → a live drawing on your chart, every step verifiable. That's all you need to start.

> Placing orders *is* possible, but it ships **default-off** behind three independent safety gates and is deliberately not part of the zero-code path — see [TRADING.md](TRADING.md) only if you decide you want it.

> **Trading something other than NQ?** Candle fetching is validated strictly and fails closed — it refuses rather than hand you partial or misaligned data. An instrument that trades in every 5-minute bucket is held to having every bar. One that doesn't is marked `density: "thin"` in `src/core/sessions/registry.ts`, and its days are verified against the daily bar's volume instead. If a symbol you add shows false `incomplete` days at 5m or 15m, it needs that flag. The sub-minute timeframes (`1s`, `5s`, `15s`) tolerate a fixed share of empty buckets, measured on MNQ, so a quieter instrument's sub-minute days can still read `incomplete`; the tolerances are in `src/core/cache/validator.ts`.

**Docs map:**

- [SETUP.md](SETUP.md) — **start here.** Install → bridge → live data; every step verifiable.
- [TRADING.md](TRADING.md) — the optional, default-off order write path and its three fail-closed gates.
- [BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md) — *for algo developers:* compose your own private strategy module on the substrate.
- [examples/python/](examples/python/README.md) — *for bot developers:* the `/feed` protocol, a feed client, a bracket-order broker and a runnable bot.
- [CLAUDE.md](CLAUDE.md) — boundary rules for agents working in this repo.
- [bedivere](https://github.com/WelokkDev/bedivere) — *separate repo, for Python algo developers:* my backtest-and-live engine.

---

## Architecture

```
                    ┌──────────────────────────┐
                    │  Claude (MCP client)     │
                    └────────────┬─────────────┘
                                 │  MCP over stdio
                                 ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  ninjatrader-mcp (Node.js process)                               │
  │                                                                  │
  │   MCP tools (src/tools/) — 21 generic tools, plus:               │
  │     6 write tools (place/oco/change when trading is enabled;     │
  │     cancel/cancel_all/flatten when accounts are allow-listed)    │
  │     list_sessions (registered by the hub itself)                 │
  │                                                                  │
  │   Bridge (src/bridge/)          SQLite (data/candles.db, WAL)    │
  │   - WS server on 127.0.0.1:9472 - candles (1s/5s/15s/5m/15m,     │
  │   - Bearer-token auth             1d raw; 30m–4h from 15m)       │
  │   - one active NT8 client       - trades ledger                  │
  │   - /feed push channel          - live subscriptions, positions  │
  │     for local bots              - order-submission audit         │
  │                                                                  │
  │   Live runtime (src/live/)      Execution (src/execution/)       │
  │   - subscription registry       - one submit path:               │
  │   - bar recorder + gap healer     ExecutionService.submit()      │
  │   - position feed               - fail-closed gate + audit       │
  │                                                                  │
  │   src/private/ (gitignored, yours)                               │
  │   - your decision engine, strategies, tools — composed           │
  │     per BUILD-YOUR-OWN.md                                        │
  └───────┬────────────────────────────▲──────────────────┬──────────┘
          │  WebSocket (loopback only) │                  │ read-only
          │  hello/heartbeat ·         │                  │ snapshot copy
          │  request_candles ·         │                  ▼
          │  live bar & position       │        ┌────────────────────┐
          │  streams · draw/clear ·    │        │ NinjaTrader.sqlite │
          │  order submit (gated)      │        │ (NT8's own trade   │
          ▼                            │        │  store; no bridge  │
  ┌───────────────────────────────────┴──────┐ │  involved)         │
  │  NinjaTrader 8 (Windows)                 │ └────────────────────┘
  │  ├─ addons/mcp-bridge.cs                 │
  │  │   WS client; serves candles; streams  │
  │  │   live bars + positions; retains draw │
  │  │   commands; gated order submit        │
  │  └─ indicators/mcp-renderer.cs           │
  │      renders bridge drawings on charts   │
  └──────────────────────────────────────────┘
```

### Data flow

1. **MCP client → server (stdio).** Claude invokes a tool; handlers run in-process in the Node server. stdout is reserved for the MCP protocol — all logging goes to stderr.
2. **Server ↔ NT8 (WebSocket).** The bridge is a WebSocket *server* bound to `127.0.0.1:9472`; the NT8 AddOn dials out to it with `Authorization: Bearer <token>`. Nothing reaches in from the internet. One NT8 client at a time (a second connection gets 409). The AddOn heartbeats every 10s; the server drops the connection after 30s of silence and the AddOn reconnects with backoff.
3. **Historical fill.** `get_candles` classifies every session day in the requested range (complete / partial / empty / in-progress) and fetches each incomplete day from NT8 as its own `request_candles` window — windows are deliberately not merged, so one slow day can't poison the range. Responses ingest idempotently even after the 30s request timeout ("late heal"). `prefetch_candles` does the same in the background for bulk history.
4. **Live fill.** `subscribe_live_bars` streams closed bars from NT8 straight into the same cache `get_candles` reads — 30m–4h derive automatically on 15m closes. Subscriptions persist across server restarts, replay on every NT8 reconnect, and missed bars heal automatically via `request_candles`. Local bots can consume the same stream over `ws://127.0.0.1:9472/feed` with the same bearer token.
5. **Positions (read-only).** `get_positions` and the position event feed observe accounts — fills, order changes, position transitions, with snapshot self-heal on reconnect. When NT8 is disconnected the answer is marked stale, never assumed flat.
6. **Trade import (no bridge).** `get_trades` / `sync_trades` read NinjaTrader's own `NinjaTrader.sqlite` directly — via a temp snapshot copy, never the live file — pair executions into round-trip trades, and store them in the ledger.
7. **Orders (default-off).** There is exactly one write path — `ExecutionService` (place, OCO exit pairs, change, cancel, cancel-all, flatten) — behind three independent fail-closed gates (tool registration, runtime config, and a C#-side gate the server can't recompile away). Risk-reducing ops (cancel/flatten) are allow-list-only so they keep working through a kill-switch. Every attempt is audited. See [TRADING.md](TRADING.md).

---

## MCP tools

The public server (`build/index.js`) registers 22 tools (21 with `NT_NO_HUB=1`: `list_sessions` is hub-only). The write tools appear conditionally: `place_order` / `place_oco` / `change_order` only when trading is enabled at startup, `cancel_order` / `cancel_all` / `flatten` whenever any account is allow-listed (so a kill-switch restart keeps orders manageable).

### Market data

| Tool | Summary |
|---|---|
| `get_candles` | OHLCV for `(symbol, timeframe, start, end)` session-day range from the cache, auto-filling missing days from NT8. **Fail-closed:** if the range's expected bar count exceeds `limit` (default 500) it refuses rather than silently truncating, and every response reports expected vs. actual counts plus per-day validation. The sub-minute TFs are dense — per session-day roughly 82,800 buckets at `1s`, 16,560 at `5s`, 5,520 at `15s` — and always need an explicit `limit`. They are also sparse: NT8 emits no bar for a bucket that saw no tick, so a legitimate `1s` day returns well under its full grid. |
| `resolve_session_days` | Pure calendar math: converts a date range or a relative anchor (`today`, `last-week`, `last-n-sessions`, …) into exact session days with ET spans, unix bounds, and per-timeframe bar-count estimates. Fetches nothing. Holidays/early closes come from the session calendar synced from NT8; `holidaysModeled: false` flags a calendar-blind template. |
| `prefetch_candles` / `prefetch_status` / `prefetch_cancel` | Bulk history pull in the background, one NT8 request at a time, verifying each day against the cache. Already-complete days are skipped, so re-issuing resumes rather than redoes. Jobs live in server memory and don't survive a restart — check `prefetch_status` for failed days. |

### Live streaming

| Tool | Summary |
|---|---|
| `subscribe_live_bars` / `unsubscribe_live_bars` | Stream live **closed** bars for a symbol into the candle cache (raw TFs: `5m` default, `15m`, and `15s`/`5s`/`1s` on demand). Answers with the truth from NT8 — `acked` plus the resolved contract — not just "message sent". Persists across restarts, replays on reconnect, gap-heals automatically. |
| `live_feed_status` | Per-subscription health: acked state, contract, lag, dup/out-of-order/gap counters, heals in flight, `/feed` consumer count, position-feed health. |
| `get_positions` | Read-only open positions per account (sim vs. live never merged): average entry, working stops/targets matched into dollar risk and R, unrealized P&L with its price source and age. Disconnected ⇒ `stale: true`, treated as *unknown*, never as flat. |
| `subscribe_live_positions` / `unsubscribe_live_positions` | Sparse event feed (fills, order changes, position transitions) with full-snapshot self-heal; adds per-trade age, fill history, and MAE/MFE to `get_positions`. |
| `list_sessions` | Every conversation attached to the hub and what each holds — bar subscriptions, running prefetch jobs, drawings, idle time — plus the hub process and whether it is serving an older build than the one on disk. |

**For bots and dashboards** the same port serves a push channel, `ws://127.0.0.1:9472/feed`: bars in, orders out. [`examples/python/`](examples/python/README.md) documents it and ships a client to start from.

### Chart drawing & reads

| Tool | Summary |
|---|---|
| `draw` | Draw a generic primitive on the NT8 chart: `rectangle`, `hline`, `vline`, or `text`, with optional style (`color`, `opacity`, `label`). |
| `clear_zones` | Remove drawn primitives: by id, everything with `all: true`, or — the default — only what this conversation drew; optionally scoped to one symbol. |
| `list_open_charts` | Enumerate open NT8 charts/tabs and their symbols. |
| `navigate_chart` | Programmatic Go To: scroll a chart to a date/time (centered or right-aligned) and/or zoom to a bar count; selects the tab, focuses the window, and reports the resulting visible range. Only reaches what the chart has loaded — `clamped: true` in the response means increase the chart's Days To Load. |
| `list_chart_indicators` | Discover the indicators on your open charts: identity, the indicator's own configured parameters, plot styling, readable depth, and an `id` handle. Step 1 of the two-step indicator read. |
| `read_indicator_values` | Read one indicator's computed plot values — by `id` (preferred) or a `name` + params selector — as the last N points or a `from`/`to` unix range. |
| `set_indicator_params` | Change one indicator's settings — the same names `list_chart_indicators` reports — then rebuild it through the chart's own reload command so the change reaches history. |

Drawings survive chart reloads: the AddOn retains every draw command per symbol and the renderer replays them when a chart's data series reloads. All drawing tools fail closed with a clear message when NT8 is not connected.

**Reading indicators is discover-then-poll:** call `list_chart_indicators` once for an `id`, then poll `read_indicator_values` with it — the poll is lean (values only, no reflection). An `id` is stable within a session but a chart reload or timeframe switch recreates indicators and invalidates it; the read then answers `found: false` (a normal outcome, not an error) and you re-discover. Value timestamps use the same unix-seconds convention as `get_candles`, so points line up 1:1 with candles. When a plot's `availableFrom`/`availableTo` are narrower than the range you asked for, you hit that indicator instance's value-retention wall (`readableDepth`, usually NT8's default 256 bars) rather than a gap in the chart — the response reports the chart's own loaded window alongside, so the two are distinguishable. Both tools are strictly read-only; `set_indicator_params` is the only write, and neither tool can add or remove an indicator.

**Writing a setting takes a rebuild.** NT8 only applies a changed setting by re-running the indicator over history — what the Indicators dialog's Apply does — and exposes no API for it, so the tool drives whatever reload command the chart itself binds, and reports a rebuild it cannot confirm rather than claiming success.

### Trade import (from NinjaTrader's own database)

| Tool | Summary |
|---|---|
| `get_trades` | Return imported live trades in `[from, to]`; ingests from NinjaTrader on demand when the range is empty or `sync: true`. |
| `sync_trades` | Explicit refresh: ingest NT executions for a range, return `{fetched, inserted}`. Optional per-call `account` override. |

The importer copies `NinjaTrader.sqlite` (plus WAL/SHM) to a temp snapshot, integrity-checks it, and reads via a 4-table join. Trade side comes from `Orders.OrderAction` — fail-closed, never guessed. Executions are FIFO-paired into round trips per (account, symbol) over the **full** execution history, handling scale-ins, partial exits, and position flips; the requested range only filters the paired output. Inserts dedupe on `(source, external_id)`, so re-syncing is idempotent. Only closed round trips are imported (v1).

### Order placement & management (default-off)

| Tool | Summary |
|---|---|
| `place_order` | Submit a single order (Market / Limit / Stop / StopLimit; Day / Gtc / Ioc) to an allow-listed account. **Absent from the tool surface entirely unless trading was enabled at startup.** An ack means NT8 accepted the submit — not a fill; confirm with `get_positions`. |
| `place_oco` | Place a protective stop + profit target as one atomic OCO exit pair; when one leg completes, NT8 cancels the sibling. Full trading gate (a triggered exit on a flat account opens a position). |
| `change_order` | Amend a working order in place (qty / limit / stop) — no cancel+replace gap, prices tick-rounded, effective values echoed. Full trading gate. |
| `cancel_order` | Cancel one working order by `clientOrderId`. **Risk-reducing: allow-list-gated only — works while trading is disabled.** |
| `cancel_all` | Cancel every working order for an instrument on an account — including manually placed ones. Risk-reducing. |
| `flatten` | Panic button: cancel all working orders AND close the position at market for the instrument. Risk-reducing. |

Read [TRADING.md](TRADING.md) before enabling anything.

---

## Supported instruments and timeframes

Symbols are defined in `src/core/sessions/registry.ts`, each bound to a session template:

| Symbols | Session template |
|---|---|
| ES, NQ, YM, RTY, MES, MNQ, MYM, M2K | CME US Index Futures ETH (Sun 18:00 → Fri 17:00 ET, daily 17:00–18:00 maintenance gap) |
| CL, MCL | NYMEX Energy ETH |
| GC, MGC, SIL | COMEX Metals ETH |
| M6A, M6E | CME FX Futures ETH |

Timeframes: `1s`, `5s`, `15s`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d`. Raw streams from NT8 are `1s`, `5s`, `15s`, `5m`, `15m` and `1d` (seconds history is shallow provider-side, and shallower the finer the TF — subscribe/prefetch on demand); 30m–4h are derived from 15m per session day. `1d` is one bar per session-day, close-stamped, fetched but never streamed live. Timestamps are unix seconds, **close-stamped**, with `America/New_York` as the canonical exchange timezone (DST-safe math throughout).

All bar-count and range logic goes through the session-day model (`src/core/sessions/`) — weekends and the maintenance break are handled structurally. Exchange holidays and early closes sync from NT8's own Trading Hours calendars on every AddOn `hello` (a bootstrap set of 2026–2027 CME holidays ships offline), and `resolve_session_days` reports `holidaysModeled` per template so calendar-blind math is never silent. Each template also names the NT8 Trading Hours template its bars are fetched under (`nt8TradingHours` in `src/core/sessions/templates.ts`); the same `hello` compares the two sets of hours and reports any difference in the server log and under `nt8Hours` in `resolve_session_days`.

---

## Build and run

```bash
npm install
npm run build     # private-free: tsc, then a private-module step that no-ops when src/private/ is absent
npm start
```

A fresh clone builds clean with no private module. `npm start` runs the **hub**, the one process that owns the NT8 bridge, the candle cache and the live feeds; every MCP conversation attaches to it through the repo's `.mcp.json`, with no per-user editing.

On the NT8 side there are two files to copy and compile: `ninja-addon/addons/mcp-bridge.cs` (the AddOn) and `ninja-addon/indicators/mcp-renderer.cs` (the renderer; attach it to every chart the server should draw on). Both are **the developer's own steps**.

**[SETUP.md](SETUP.md) is the walkthrough** for all of it: first run and the bridge token, the NT8 side, environment variables and config files, NT8 in a VM, and a troubleshooting table for every failure mode.

---

## Development

```bash
npm test                 # vitest, one-shot — private-free (runs src/private/tests/ too when present)
npm run test:watch
npm run typecheck        # public only; private counterpart: npm run typecheck:private
npm run inspect          # MCP inspector against the built server
```

Vitest picks up `test/` plus co-located `__tests__/` under `src/` (bridge, core, tools, execution). Tests run against a throwaway `.test-data/` DB, never `data/candles.db`.

Most tool handlers follow a factory + register pattern (`createXHandler(deps)` for dependency-injected testing, `registerX(server)` to wire real deps) — to add a tool with the testing pattern, copy the shape of `src/tools/draw.ts`.

Public test coverage highlights: bridge wire protocol round-trips, candle aggregation across session/DST boundaries, session-day math, cache gap-fill planning and validation, the `get_candles` fail-closed gate, `resolve_session_days` anchors, drawing tools, the execution gateway's fail-closed gates, execution pairing and trade ingest, and the NinjaTrader SQLite reader.

### Ops scripts

| Script | Purpose |
|---|---|
| `npm run seed` | Load `data/sample/*_15m.csv` into the cache and derive higher timeframes. |
| `npm run rebuild-bars` | Wipe the candle cache (it refills on demand). |
| `npm run dump-bars` | Print cached bars for a symbol/day-range in ET for eyeballing against NT8. |
| `npm run audit-bars` | Structural audit of every cached (symbol, session-day) against session geometry; exit 1 on mismatch. |

`src/scripts/` also contains dev harnesses that fake the NT8 side of the bridge (`fake-nt-candles.ts`, `fake-nt-handshake.ts`, `fake-nt-listen.ts`) and a standalone bridge REPL (`bridge-only.ts`).

---

## Project layout

```
src/
  index.ts             public MCP bin — every generic tool, no private module needed
  server.ts            the composition seam: registerGenericTools /
                       startRuntime
  bridge/              WS server, wire protocol (zod), auth, connection manager,
                       candle + live ingest, /feed consumer hub
  live/                live feed runtime: subscription registry, recorder,
                       gap healer, position feed
  execution/           order gateway: config, fail-closed gate, audit,
                       ExecutionService (the one submit path)
  core/                sessions (session-day math, templates, registry, calendar),
                       aggregator, time/ET helpers, cache fill + validator
  db/                  SQLite connection, schema, ledger DAO
                       (candles + trades share data/candles.db)
  tools/               MCP tool handlers
  trade-source/        NinjaTrader.sqlite reader, execution pairing, ingest
  scripts/             ops scripts + fake-NT dev harnesses
  private/             (gitignored, yours) your methodology — see BUILD-YOUR-OWN.md
ninja-addon/
  addons/              NT8 AddOn (McpBridge — WS client, candle server, live streams,
                       draw store, gated order submit)
  indicators/          McpBridgeRenderer
scripts/               mcp-entry.mjs (bin auto-switch), init-private.mjs, build-private.mjs
examples/python/       /feed client, bracket-order broker, and a runnable bot
test/                  vitest suites for public infrastructure
data/
  sample/              tracked seed fixtures
  candles.db           created at runtime (gitignored)
docs/                  (gitignored) local design docs and specs
```

---

## For algo developers: build your own (optional)

Everything above works with zero code. This section is the **other half** of the project, and you can skip it entirely if you only want to trade by hand.

The repo is structured **open-core**. The substrate — bridge, cache, live feeds, session math, drawing, trade import, execution gateway, NT8 AddOn — is public. The trading *methodology* (zone detection, decision engines, strategy configs) lives in each developer's own gitignored `src/private/` module, composed on top through `registerGenericTools` / `startRuntime` in `src/server.ts`. Public code never imports private, and a fresh clone builds and tests clean without it. The split is recent, so expect the traces the status note at the top describes.

**Backtesting lives in [bedivere](https://github.com/WelokkDev/bedivere), not here.** The Strategy Lab this repo used to ship (the `start_experiment` tools) is deprecated and has been removed. bedivere is the public version of my Python engine: one loop runs both the backtest and the live session, so what you test is what you deploy. It ships no NinjaTrader connection; [`examples/python/`](examples/python/) here is where to start for one.

**What's still poorly defined is the build-your-own backend.** [BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md) gets you reliably from scaffold to your first custom tool, but past that point there are gaps, and you should expect to read source and makeshift:

- **No worked recipe for the live feed in BUILD-YOUR-OWN.md** — `subscribe_live_bars` is covered in [SETUP.md](SETUP.md) §8 and [`examples/python/`](examples/python/README.md) has a working `/feed` bot to start from, but wiring a feed consumer into your private module is yours to assemble.
- **No CI yet** enforces the public-only build or the import boundary; discipline does.

If you hit a wall composing a private module, that's expected at this stage — the seams are young. Issues describing where you had to improvise are the most useful kind. To start: **[BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md)**.

---

## License

MIT — see [LICENSE](LICENSE).
