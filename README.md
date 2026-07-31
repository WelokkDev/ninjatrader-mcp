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
| **Review your trading** — your real executed trades imported straight from NinjaTrader's database and paired into round trips | `get_trades`, `sync_trades`, `list_trades` |

Everything above is **read-only or draw-only** — the bridge never touches your orders. **[SETUP.md](SETUP.md)** is the whole walkthrough: install → bridge → a live drawing on your chart, every step verifiable. That's all you need to start.

> Placing orders *is* possible, but it ships **default-off** behind three independent safety gates and is deliberately not part of the zero-code path — see [TRADING.md](TRADING.md) only if you decide you want it.

> **Trading something other than NQ?** Candle fetching is validated strictly and fails closed — it refuses rather than hand you partial or misaligned data. Those checks were tuned against NQ (one of the most liquid contracts), so a thinner symbol can trip them: pulling candles — especially `15s` — for CL, GC, or any less-liquid instrument may surface false `incomplete` / `empty` days, which show up as `get_candles` refusing or `prefetch_status` reporting failed days. The other liquid CME index futures (ES, YM, RTY, and the micros) behave just like NQ. If you hit this, the sparse-bar tolerances live in `src/core/cache/validator.ts`.

**Docs map:**

- [SETUP.md](SETUP.md) — **start here.** Install → bridge → live data; every step verifiable.
- [TRADING.md](TRADING.md) — the optional, default-off order write path and its three fail-closed gates.
- [BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md) — *for algo developers:* compose your own private strategy module on the substrate.
- [CLAUDE.md](CLAUDE.md) — boundary rules for agents working in this repo.

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
  │   MCP tools (src/tools/) — 19 generic tools, plus:               │
  │     6 write tools (place/oco/change when trading is enabled;     │
  │     cancel/cancel_all/flatten when accounts are allow-listed)    │
  │     5 experiment-lab tools (registered by private bins           │
  │     that bind a Lab to their own engine)                         │
  │                                                                  │
  │   Bridge (src/bridge/)          SQLite (data/candles.db, WAL)    │
  │   - WS server on 127.0.0.1:9472 - candles (15s/5m/15m raw,       │
  │   - Bearer-token auth             30m–4h derived from 15m)       │
  │   - one active NT8 client       - trades / decisions ledger      │
  │   - /feed push channel          - live subscriptions, positions  │
  │     for local bots              - order-submission audit         │
  │                                                                  │
  │   Live runtime (src/live/)      Execution (src/execution/)       │
  │   - subscription registry       - one submit path:               │
  │   - bar recorder + gap healer     ExecutionService.submit()      │
  │   - position feed               - fail-closed gate + audit       │
  │                                                                  │
  │   Lab (src/lab/ + adapters/)    src/private/ (gitignored, yours) │
  │   - generic experiment          - your decision engine,          │
  │     orchestrator                  strategies, tools — composed   │
  │   - detached runner process       per BUILD-YOUR-OWN.md          │
  │   - disk-as-truth recovery                                       │
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
  │  ├─ indicators/mcp-renderer.cs           │
  │  │   renders bridge drawings on charts   │
  │  └─ indicators/mcp-sma-snapshot.cs       │
  │      optional R&D parity snapshot writer │
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
8. **Experiments run out of process.** `start_experiment` returns immediately; the lab spawns a detached runner that writes progress and results to `backtest-results/<experimentId>/`. The lab re-derives run state from **disk** on every restart, so killed servers or orphaned runs reconcile instead of dangling.

---

## MCP tools

The public server (`build/index.js`) registers 23 tools. The write tools appear conditionally: `place_order` / `place_oco` / `change_order` only when trading is enabled at startup, `cancel_order` / `cancel_all` / `flatten` whenever any account is allow-listed (so a kill-switch restart keeps orders manageable). The five lab tools appear only in a private bin that binds a `Lab` to its own engine (see [BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md)).

### Market data

| Tool | Summary |
|---|---|
| `get_candles` | OHLCV for `(symbol, timeframe, start, end)` session-day range from the cache, auto-filling missing days from NT8. **Fail-closed:** if the range's expected bar count exceeds `limit` (default 500) it refuses rather than silently truncating, and every response reports expected vs. actual counts plus per-day validation. `15s` is dense (5,520 bars/session-day) and always needs an explicit `limit`. |
| `resolve_session_days` | Pure calendar math: converts a date range or a relative anchor (`today`, `last-week`, `last-n-sessions`, …) into exact session days with ET spans, unix bounds, and per-timeframe bar-count estimates. Fetches nothing. Holidays/early closes come from the session calendar synced from NT8; `holidaysModeled: false` flags a calendar-blind template. |
| `prefetch_candles` / `prefetch_status` / `prefetch_cancel` | Bulk history pull in the background, one NT8 request at a time, verifying each day against the cache. Already-complete days are skipped, so re-issuing resumes rather than redoes. Jobs live in server memory and don't survive a restart — check `prefetch_status` for failed days. |

### Live streaming

| Tool | Summary |
|---|---|
| `subscribe_live_bars` / `unsubscribe_live_bars` | Stream live **closed** bars for a symbol into the candle cache (raw TFs: `5m` default, `15m`, `15s` on demand). Answers with the truth from NT8 — `acked` plus the resolved contract — not just "message sent". Persists across restarts, replays on reconnect, gap-heals automatically. |
| `live_feed_status` | Per-subscription health: acked state, contract, lag, dup/out-of-order/gap counters, heals in flight, `/feed` consumer count, position-feed health. |
| `get_positions` | Read-only open positions per account (sim vs. live never merged): average entry, working stops/targets matched into dollar risk and R, unrealized P&L with its price source and age. Disconnected ⇒ `stale: true`, treated as *unknown*, never as flat. |
| `subscribe_live_positions` / `unsubscribe_live_positions` | Sparse event feed (fills, order changes, position transitions) with full-snapshot self-heal; adds per-trade age, fill history, and MAE/MFE to `get_positions`. |

**For bots and dashboards** there is a push channel on the same port: `ws://127.0.0.1:9472/feed`, same bearer token. Subscribing on `/feed` creates the upstream NT8 stream too, so a bot is self-sufficient. A minimal Python consumer ships at `examples/python/live_feed_client.py`. Bars tagged `backfill: true` closed well before delivery — act-on-close logic must skip them.

### Chart drawing & reads

| Tool | Summary |
|---|---|
| `draw` | Draw a generic primitive on the NT8 chart: `rectangle`, `hline`, `vline`, or `text`, with optional style (`color`, `opacity`, `label`). |
| `clear_zones` | Remove drawn primitives by id, or all of them; optionally scoped to one symbol. |
| `list_open_charts` | Enumerate open NT8 charts/tabs and their symbols. |
| `navigate_chart` | Programmatic Go To: scroll a chart to a date/time (centered or right-aligned) and/or zoom to a bar count; selects the tab, focuses the window, and reports the resulting visible range. Only reaches what the chart has loaded — `clamped: true` in the response means increase the chart's Days To Load. |
| `list_chart_indicators` | Discover the indicators on your open charts: identity, the indicator's own configured parameters, plot styling, readable depth, and an `id` handle. Step 1 of the two-step indicator read. |
| `read_indicator_values` | Read one indicator's computed plot values — by `id` (preferred) or a `name` + params selector — as the last N points or a `from`/`to` unix range. |

Drawings survive chart reloads: the AddOn retains every draw command per symbol and the renderer replays them when a chart's data series reloads. All drawing tools fail closed with a clear message when NT8 is not connected.

**Reading indicators is discover-then-poll:** call `list_chart_indicators` once for an `id`, then poll `read_indicator_values` with it — the poll is lean (values only, no reflection). An `id` is stable within a session but a chart reload or timeframe switch recreates indicators and invalidates it; the read then answers `found: false` (a normal outcome, not an error) and you re-discover. Value timestamps use the same unix-seconds convention as `get_candles`, so points line up 1:1 with candles. When a plot's `availableFrom`/`availableTo` are narrower than the range you asked for, you hit that indicator instance's value-retention wall (`readableDepth`, usually NT8's default 256 bars) rather than a gap in the chart — the response reports the chart's own loaded window alongside, so the two are distinguishable. Both tools are strictly read-only: they cannot add, remove, or reconfigure an indicator.

### Ledger reads

| Tool | Summary |
|---|---|
| `list_trades` | Read persisted trades, filterable by `runId`, `mode` (`backtest`/`paper`/`live`), `managementMode`. |
| `list_decisions` | Read per-bar decisions from a backtest. Defaults to the aggregated "stall funnel" (counts of no-verdicts by reason); the full trace is opt-in and hard-capped, because a real run holds ~15k rows. |

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

Three independent fail-closed gates (TS registration, TS runtime config, a C#-side config read immediately before every NT8 call), every attempt audited (`order_submissions` / `order_ops`). Read [TRADING.md](TRADING.md) before enabling anything.

### Experiment lab (runner-gated)

| Tool | Summary |
|---|---|
| `start_experiment` | Launch a backtest experiment in a detached process; returns `{experimentId, etaSecs, queued}` instantly. Accepts an optional pre-registered `prediction` (hypothesis, expected trade band) to score later — an anti-self-deception measure. |
| `experiment_status` | Live status: phase, percent, calibrated ETA band, recent events. |
| `experiment_result` | Normalized ~3 KB result for a finished run: decision funnel, per-mode metrics, provenance (git SHAs, config hash), integrity report. Never returns the multi-hundred-MB decision trace. |
| `list_experiments` | Compact summaries, newest first, optionally filtered by status. |
| `diff_experiments` | Diff two finished runs: funnel deltas, per-reason deltas, per-mode metric deltas, with a caution flag if config/engine differ. |

These tools only exist once a private bin calls `registerExperimentTools(server, lab)` with a `Lab` bound to a backtest engine — the public server doesn't create `data/lab.db` at all. Lab durability: each run writes a self-describing bundle under `backtest-results/<experimentId>/`; on startup and every 20s the lab reconciles in-flight state from **disk**, adopting completed bundles, marking dead processes failed, and recovering runs orphaned by a restart.

---

## Supported instruments and timeframes

Symbols are defined in `src/core/sessions/registry.ts`, each bound to a session template:

| Symbols | Session template |
|---|---|
| ES, NQ, YM, RTY, MES, MNQ, MYM, M2K | CME US Index Futures ETH (Sun 18:00 → Fri 17:00 ET, daily 17:00–18:00 maintenance gap) |
| CL | NYMEX Energy ETH |
| GC | COMEX Metals ETH |

Timeframes: `15s`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`. Raw streams from NT8 are `15s`, `5m`, and `15m` (`15s` history is shallow provider-side — subscribe/prefetch on demand); 30m–4h are derived from 15m per session day. Daily bars are not cached. Timestamps are unix seconds, **close-stamped**, with `America/New_York` as the canonical exchange timezone (DST-safe math throughout).

All bar-count and range logic goes through the session-day model (`src/core/sessions/`) — weekends and the maintenance break are handled structurally. Exchange holidays and early closes sync from NT8's own Trading Hours calendars on every AddOn `hello` (a bootstrap set of 2026–2027 CME holidays ships offline), and `resolve_session_days` reports `holidaysModeled` per template so calendar-blind math is never silent.

---

## Build and run

```bash
npm install
npm run build     # private-free: tsc, then a private-module step that no-ops when src/private/ is absent
npm start
```

A fresh clone builds clean — no private module required. On first run, the server creates `data/candles.db` (SQLite, WAL; schema is idempotent — nothing to create by hand), generates a bearer token, writes it to `.env.local`, and prints it once to stderr. Paste that token into NT8's `bridge.config.json`, then start NT8 with the McpBridge AddOn compiled. **[SETUP.md](SETUP.md) is the real walkthrough** — install → bridge → verified live data, with a troubleshooting table for every failure mode.

The repo's `.mcp.json` already wires the server into Claude Code:

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

`scripts/mcp-entry.mjs` boots `build/private/index.js` when a private module has been built, otherwise `build/index.js` — no per-user editing. **Run exactly one server process**: whichever starts first owns the bridge port and the candle cache; a second finds the port taken and runs bridge-disabled (a bridge failure is never fatal — the server continues cache-only with a warning).

### Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `NT_BRIDGE_TOKEN` | auto-generated, persisted to `.env.local` | Shared secret between server and NT8 AddOn. |
| `NT_BRIDGE_PORT` | `9472` | Loopback TCP port for the bridge; an invalid value disables the bridge but not the server. |
| `NT_DATA_PATH` | `<repo>/data` | Directory for `candles.db`, `lab.db`, and lab calibration. |
| `NT_TRADES_CONFIG` | `<repo>/ninjatrader.config.json` | Path to the trade-import config. |
| `NT_TRADING_*` | unset ⇒ **disabled** | Order write path enablement — see [TRADING.md](TRADING.md). |

### Config files

| File | Where | Tracked? | Purpose |
|---|---|---|---|
| `.env.local` | repo root | no | `NT_BRIDGE_TOKEN=<64-hex>` (created on first run) and, opt-in, the `NT_TRADING_*` variables. |
| `ninjatrader.config.json` | repo root | no | `{ "dbPath": ..., "account"? }` for trade import; copy the tracked `.example.json`. |
| `bridge.config.json` | NT8 user data dir | — | `{ "token", "url" }` — the AddOn's connection config; re-read every 5s while disconnected. |
| `trading.config.json` | NT8 user data dir | — | The C#-side order gate; missing ⇒ write path disabled. See [TRADING.md](TRADING.md). |
| `data/lab-calibration.json` | repo | yes | Experiment ETA calibration data. |
| `data/sample/*.csv` | repo | yes | 15m fixtures for `npm run seed` (offline cache proof, no NT8 needed). |

### NT8 side

Two files to copy and compile — `ninja-addon/addons/mcp-bridge.cs` (AddOn) and `ninja-addon/indicators/mcp-renderer.cs` (renderer; attach it to every chart the server should draw on). `mcp-sma-snapshot.cs` is optional R&D — skip it. Copying and compiling in the NinjaScript Editor are **the developer's own steps** (see [SETUP.md](SETUP.md) §4–5, including the Trading Hours template mapping, which fails closed rather than silently serving RTH data).

---

## Development

```bash
npm test                 # vitest, one-shot — private-free (runs src/private/tests/ too when present)
npm run test:watch
npm run typecheck        # public only; private counterpart: npm run typecheck:private
npm run inspect          # MCP inspector against the built server
```

Vitest picks up `test/` plus co-located `__tests__/` under `src/` (bridge, core, tools, lab, adapters, execution). Tests run against a throwaway `.test-data/` DB, never `data/candles.db`.

Most tool handlers follow a factory + register pattern (`createXHandler(deps)` for dependency-injected testing, `registerX(server)` to wire real deps) — to add a tool with the testing pattern, copy the shape of `src/tools/draw.ts`.

Public test coverage highlights: bridge wire protocol round-trips, candle aggregation across session/DST boundaries, session-day math, cache gap-fill planning and validation, the `get_candles` fail-closed gate, `resolve_session_days` anchors, drawing tools, the execution gateway's fail-closed gates, execution pairing and trade ingest, the NinjaTrader SQLite reader, and lab lifecycle + restart recovery.

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
                       registerExperimentTools / startRuntime
  bridge/              WS server, wire protocol (zod), auth, connection manager,
                       candle + live ingest, /feed consumer hub
  live/                live feed runtime: subscription registry, recorder,
                       gap healer, position feed
  execution/           order gateway: config, fail-closed gate, audit,
                       ExecutionService (the one submit path)
  core/                sessions (session-day math, templates, registry, calendar),
                       aggregator, time/ET helpers, cache fill + validator
  db/                  SQLite connection, schema, ledger DAO
                       (candles + trades + decisions share data/candles.db)
  tools/               MCP tool handlers
  lab/                 generic experiment orchestrator (store, runner port, ETA,
                       observability, integrity, diff) — engine-agnostic
  adapters/
    ninjatrader/       detached backtest-runner adapter + result-bundle mapper
  trade-source/        NinjaTrader.sqlite reader, execution pairing, ingest
  scripts/             ops scripts + fake-NT dev harnesses
  private/             (gitignored, yours) your methodology — see BUILD-YOUR-OWN.md
ninja-addon/
  addons/              NT8 AddOn (McpBridge — WS client, candle server, live streams,
                       draw store, gated order submit)
  indicators/          McpBridgeRenderer, McpSmaSnapshot (optional R&D)
scripts/               mcp-entry.mjs (bin auto-switch), init-private.mjs, build-private.mjs
examples/python/       minimal /feed WebSocket consumer
test/                  vitest suites for public infrastructure
data/
  sample/              tracked seed fixtures
  candles.db, lab.db   created at runtime (gitignored)
backtest-results/      (gitignored) per-experiment run bundles
docs/                  (gitignored) local design docs and specs
```

---

## For algo developers: build your own (optional)

Everything above works with zero code. This section is the **other half** of the project, and you can skip it entirely if you only want to trade by hand.

The repo is structured **open-core**. The substrate — bridge, cache, live feeds, session math, drawing, trade import, ledger, experiment lab, execution gateway, NT8 AddOn — is public, here in this repo. The trading *methodology* (zone detection, decision engines, strategy configs) is meant to live **not here**: in each developer's own gitignored `src/private/` module, composed on top. The aim is that public code never imports private and a **fresh clone builds and tests clean with no `src/private/`** (`tsc` excludes it), with the composition seam — `registerGenericTools` / `registerExperimentTools` / `startRuntime` in `src/server.ts` — exercised daily. But this split is recent: remnants of my own methodology, and of my own NT8 setup, probably still linger in pieces of the public code — field names, spec shapes, the odd default — so expect to find traces. The split is architectural, not yet surgical, and I'm still working on it.

Building a private module unlocks two more tool surfaces:

- **The write tools** — `place_order` / `place_oco` / `change_order` appear only when trading is enabled at startup; `cancel_order` / `cancel_all` / `flatten` whenever any account is allow-listed. See [TRADING.md](TRADING.md).
- **Five experiment-lab tools** (`start_experiment`, `experiment_status`, `experiment_result`, `list_experiments`, `diff_experiments`) appear only in a private bin that binds a `Lab` to your own backtest engine. The public server doesn't create `data/lab.db` at all.

**What's still poorly defined is the build-your-own backend.** [BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md) gets you reliably from scaffold to your first custom tool, but past that point there are gaps, and you should expect to read source and makeshift:

- **Binding your own backtest engine to the lab is improvised, not paved.** The runner port (`src/lab/runner/types.ts`) is documented in-code, but the result contract (`ExperimentResult`, the decision funnel) lives only in `src/lab/types.ts`, and the bundle layout the stock `NinjaTraderRunner` adapter expects (`summary.json` / `funnel.json` / `run-meta.json`) is implicit in `src/adapters/ninjatrader/map-bundle.ts`. You'll be lining shapes up by hand.
- `ExperimentSpec` still carries fields from my own methodology (`strategy`, `smaPreset`); treat `extra` as the generic escape hatch for your engine's knobs.
- **No worked recipe for the live feed in BUILD-YOUR-OWN.md** — `subscribe_live_bars` and the `/feed` channel are documented in [SETUP.md](SETUP.md) §8, but the only consumer example is `examples/python/live_feed_client.py`. Anything like "alert me when my signal triggers" is yours to assemble on top of it.
- **No CI yet** enforces the public-only build or the import boundary; discipline does.

If you hit a wall composing a private module, that's expected at this stage — the seams are young. Issues describing where you had to improvise are the most useful kind. To start: **[BUILD-YOUR-OWN.md](BUILD-YOUR-OWN.md)**.

---

## License

MIT — see [LICENSE](LICENSE).
