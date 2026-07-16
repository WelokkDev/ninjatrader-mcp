# ninjatrader-mcp

MCP server bridging Claude Code to NinjaTrader 8: a session-day-aware futures candle cache, chart drawing, executed-trade import from NinjaTrader's own database, a persisted trade/decision ledger, and an asynchronous backtest experiment lab.

The MCP server runs locally over stdio, exposes tools to an MCP client (e.g., Claude), and maintains a WebSocket bridge to an NT8 AddOn. The AddOn answers historical candle requests and renders drawings onto charts; the server owns caching, validation, session math, and persistence.

---

## Status — work in progress

This is a personal trading-research project under active development. The **public / private split is currently weak**: the proprietary trading logic (zone detection, the decision engine, the SMA-state engine, strategy configurations) lives in a gitignored module at `src/private/`. The infrastructure — bridge, cache, session math, drawing, trade import, ledger, experiment lab, NT8 AddOn — is all here in the public repo.

What this means for a fresh clone today:

- **`npm run build` and `npm run typecheck` fail without `src/private/`.** The build's `generate:schema` step reads `src/private/sma/types.ts`, and four public tool files import private modules directly (`src/tools/scan-zones.ts`, `get-playing-field.ts`, `scan-for-trade.ts`, `run-backtest.ts`), which `src/index.ts` registers. There is no public-only build target yet.
- **Private-independent at compile time:** everything else — the bridge, cache/session/aggregation core, trade import, ledger, the entire lab orchestrator, and the NT8 C# sources. The lab adapter touches the private engine only by spawning a built script path (`build/private/scripts/run-backtest-observable.js`), so running an experiment still requires the private module at runtime.
- `docs/` is also gitignored (local design docs and specs), so a clone contains only the public `src/` tree, `ninja-addon/`, `test/`, and the tracked sample data.

The plan to amend this: refactor the private-importing tools onto a public seam (dependency-injected providers rather than direct imports), ship a private-module template so others can plug in their own methodology, and document the boundary contracts (strategy/quantifier interfaces, the bridge wire protocol). Until that lands, treat anything referencing `src/private/` as a dependency you cannot satisfy from this repo.

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
  │   MCP tools (src/tools/) — 18 tools:                             │
  │     market data · drawing · decision engine (private) ·          │
  │     ledger reads · trade import · experiment lab                 │
  │                                                                  │
  │   Bridge (src/bridge/)          SQLite (data/candles.db, WAL)    │
  │   - WS server on 127.0.0.1:9472 - candles (5m/15m raw,           │
  │   - Bearer-token auth             30m–4h derived from 15m)       │
  │   - one active client           - trades / decisions ledger      │
  │   - session-day gap-fill        - structural validation          │
  │                                                                  │
  │   Lab (src/lab/ + adapters/)    src/private/ (gitignored)        │
  │   - experiment orchestrator     - decision engine, zone          │
  │   - detached runner process       pipeline, SMA engine,          │
  │   - disk-as-truth recovery        strategy configs               │
  │   - data/lab.db +                                                │
  │     backtest-results/<id>/                                       │
  └───────┬────────────────────────────▲──────────────────┬──────────┘
          │  WebSocket (loopback only) │                  │ read-only
          │  ▼ hello_ack, draw,        │                  │ snapshot copy
          │    draw_zone, clear_zones, │                  ▼
          │    request_candles         │        ┌────────────────────┐
          │  ▲ hello, heartbeat,       │        │ NinjaTrader.sqlite │
          │    candles_response, error │        │ (NT8's own trade   │
          ▼                            │        │  store; no bridge  │
  ┌───────────────────────────────────┴──────┐ │  involved)         │
  │  NinjaTrader 8 (Windows)                 │ └────────────────────┘
  │  ├─ addons/mcp-bridge.cs                 │
  │  │   WS client; serves 5m/15m candles;   │
  │  │   retains draw commands for replay    │
  │  ├─ indicators/mcp-renderer.cs           │
  │  │   renders bridge drawings on charts   │
  │  ├─ indicators/mcp-sma.cs                │
  │  │   preset-driven SMA overlay           │
  │  └─ indicators/mcp-sma-snapshot.cs       │
  │      SMA parity snapshot writer (R&D)    │
  └──────────────────────────────────────────┘
```

### Data flow

1. **MCP client → server (stdio).** Claude invokes a tool; handlers run in-process in the Node server. stdout is reserved for the MCP protocol — all logging goes to stderr.
2. **Server ↔ NT8 (WebSocket).** The bridge is a WebSocket *server* bound to `127.0.0.1:9472`; the NT8 AddOn dials out to it with `Authorization: Bearer <token>`. Nothing reaches in from the internet. One client at a time (a second connection gets 409). The AddOn heartbeats every 10s; the server drops the connection after 30s of silence.
3. **Server ↔ cache (SQLite).** `get_candles` classifies every session day in the requested range (complete / partial / empty / in-progress) and fetches each incomplete day from NT8 as its own `request_candles` window — windows are deliberately not merged, so one slow day can't poison the range. Responses are ingested idempotently even if they arrive after the 30s request timeout ("late heal"). Today's in-progress session day is always refetched, which is how the view stays fresh — there is no live push stream from NT8 (the protocol reserves `bar_close` and the server can ingest it, but the AddOn does not emit it yet).
4. **Trade import (no bridge).** `get_trades` / `sync_trades` read NinjaTrader's own `NinjaTrader.sqlite` directly — via a temp snapshot copy, never the live file — pair executions into round-trip trades, and store them in the ledger.
5. **Decision tools ↔ private module.** `scan_zones`, `get_playing_field`, `scan_for_trade`, and `run_backtest` delegate to `src/private/` for the actual methodology; the public handlers only validate, fetch cached candles, and serialize.
6. **Experiments run out of process.** `start_experiment` returns immediately; the lab spawns a detached child (a real run is ~100 minutes) that writes progress and results to `backtest-results/<experimentId>/`. The lab re-derives run state from disk on every restart, so killed servers or orphaned runs reconcile instead of dangling.

---

## MCP tools

“Private” = imports `src/private/` and cannot run from this repo alone.

### Market data

| Tool | Private? | Summary |
|---|---|---|
| `get_candles` | No | OHLCV for `(symbol, timeframe, start, end)` session-day range from the cache, auto-filling missing days from NT8 (5m raw; 30m–4h derived from 15m). **Fail-closed:** if the range's expected bar count exceeds `limit` (default 500) it refuses rather than silently truncating, and every response reports expected vs. actual counts plus per-day validation. |
| `resolve_session_days` | No | Pure calendar math: converts an explicit date range or a relative anchor (`today`, `yesterday`, `this-week`, `last-week`, `last-n-sessions`) into exact session days with ET spans, unix bounds, and per-timeframe bar-count estimates. Fetches nothing. Exchange holidays are not modeled (`holidaysModeled: false`). |

### Chart drawing

| Tool | Private? | Summary |
|---|---|---|
| `draw` | No | Draw a generic primitive on the NT8 chart: `rectangle`, `hline`, `vline`, or `text`, with optional style (`color`, `opacity`, `label`). |
| `draw_zone` | No | **Deprecated** — legacy rectangle-only path; prefer `draw`. |
| `clear_zones` | No | Remove drawn primitives by id, or all of them; optionally scoped to one symbol. |

Drawings survive chart reloads: the AddOn retains every draw command per symbol and the renderer replays them when a chart's data series reloads. All drawing tools fail closed with a clear message when NT8 is not connected.

### Decision engine (requires `src/private/`)

| Tool | Private? | Summary |
|---|---|---|
| `scan_zones` | **Yes** | Run the zone-detection pipeline over cached candles (15m–4h); returns zones with per-quantifier scores, optionally filtered by `scoreFilters` and drawn on the chart (`draw: true`). Reads the cache only — call `get_candles` first. |
| `get_playing_field` | **Yes** | Multi-timeframe trade context at one bar-close instant (`asOf`): trend, nearest target/source zones, obstacles, R/R reachability. |
| `scan_for_trade` | **Yes** | Full decision chain at one instant: verdict (yes/no), reason code, per-step trace; on yes, entry/stop/target/RR. Read-only. |
| `run_backtest` | **Yes** | Walk the decision engine over a 5m-close window in-process, replay exits under each management mode (`fixed`/`trailing`/`constrained`), and **persist trades + every decision to the ledger**. For long ranges use the lab instead. |

### Ledger reads

| Tool | Private? | Summary |
|---|---|---|
| `list_trades` | No | Read persisted trades, filterable by `runId`, `mode` (`backtest`/`paper`/`live`), `managementMode`. |
| `list_decisions` | No | Read per-bar decisions from a backtest. Defaults to the aggregated "stall funnel" (counts of no-verdicts by reason); the full trace is opt-in and hard-capped, because a real run holds ~15k rows. |

### Trade import (from NinjaTrader's own database)

| Tool | Private? | Summary |
|---|---|---|
| `get_trades` | No | Return imported live trades in `[from, to]`; ingests from NinjaTrader on demand when the range is empty or `sync: true`. |
| `sync_trades` | No | Explicit refresh: ingest NT executions for a range, return `{fetched, inserted}`. Optional per-call `account` override. |

The importer copies `NinjaTrader.sqlite` (plus WAL/SHM) to a temp snapshot, integrity-checks it, and reads via a 4-table join (`Executions` → `Instruments` → `MasterInstruments`, `Orders`, `Accounts`). Trade side comes from `Orders.OrderAction` — fail-closed, never guessed. Executions are FIFO-paired into round trips per (account, symbol) over the **full** execution history (pairing assumes a flat start), handling scale-ins, partial exits, and position flips; the requested range only filters the paired output. Inserts are deduplicated on `(source, external_id)`, so re-syncing is idempotent. Only closed round trips are imported (v1).

### Experiment lab

| Tool | Private? | Summary |
|---|---|---|
| `start_experiment` | Runtime¹ | Launch a backtest experiment in a detached process; returns `{experimentId, etaSecs, queued}` instantly. Accepts an optional pre-registered `prediction` (hypothesis, expected trade band) to score later — an anti-self-deception measure. |
| `experiment_status` | No | Live status: phase, percent, calibrated ETA band, recent events. |
| `experiment_result` | No | Normalized ~3 KB result for a finished run: decision funnel, per-mode metrics, provenance (public + private git SHAs, config hash), integrity report. Never returns the multi-hundred-MB decision trace. |
| `list_experiments` | No | Compact summaries, newest first, optionally filtered by status. |
| `diff_experiments` | No | Diff two finished runs: funnel deltas, per-reason deltas, per-mode metric deltas, with a caution flag if config/engine differ. |

¹ The lab code compiles without the private module, but the detached run executes `build/private/scripts/run-backtest-observable.js`, so actually running experiments requires it.

Lab durability: experiment records live in `data/lab.db`; each run writes a self-describing bundle under `backtest-results/<experimentId>/` (`run-meta.json`, `runner.log`, `events.jsonl`, result bundle). On startup — and every 20 seconds after — the lab reconciles in-flight state from **disk**, not memory: completed bundles are adopted, dead processes are marked failed, and runs orphaned by a server restart are recovered.

---

## Supported instruments and timeframes

Symbols are defined in `src/core/sessions/registry.ts`, each bound to a session template:

| Symbols | Session template |
|---|---|
| ES, NQ, YM, RTY, MES, MNQ, MYM, M2K | CME US Index Futures ETH (Sun 18:00 → Fri 17:00 ET, daily 17:00–18:00 maintenance gap) |
| CL | NYMEX Energy ETH |
| GC | COMEX Metals ETH |

Timeframes: `5m`, `15m`, `30m`, `1h`, `2h`, `4h`. Only 5m and 15m are fetched raw from NT8; 30m–4h are derived from 15m per session day. Daily bars are not cached. Timestamps are unix seconds, **close-stamped**, with `America/New_York` as the canonical exchange timezone (DST-safe math throughout).

All bar-count and range logic goes through the session-day model (`src/core/sessions/`) — weekends and the maintenance break are handled structurally; exchange holidays are not yet modeled and surface as validation mismatches instead.

---

## Build and run

```bash
npm install
npm run build     # requires src/private/ — see Status above
npm start
```

On first run, the server creates `data/candles.db` and `data/lab.db` (SQLite, WAL), generates a bearer token, writes it to `.env.local` (mode 0600), and prints it once to stderr. Paste that token into NT8's `bridge.config.json`, then start NT8 with the McpBridge AddOn compiled and enabled.

To wire the server into Claude Code, `.mcp.json` in this repo already registers it:

```json
{
  "mcpServers": {
    "ninjatrader": { "command": "node", "args": ["./build/index.js"], "timeout": 1800000 }
  }
}
```

A bridge failure (e.g., invalid port) is non-fatal: the MCP server keeps running with cache-only behavior and a warning.

### Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `NT_BRIDGE_TOKEN` | auto-generated, persisted to `.env.local` | Shared secret between server and NT8 AddOn. |
| `NT_BRIDGE_PORT` | `9472` | Loopback TCP port for the bridge; an invalid value disables the bridge but not the server. |
| `NT_DATA_PATH` | `<repo>/data` | Directory for `candles.db`, `lab.db`, and lab calibration. |
| `NT_TRADES_CONFIG` | `<repo>/ninjatrader.config.json` | Path to the trade-import config. |

### Config files

| File | Tracked? | Purpose |
|---|---|---|
| `.env.local` | no | `NT_BRIDGE_TOKEN=<64-hex>`; created on first run. |
| `ninjatrader.config.json` | no | `{ "dbPath": "<path to NinjaTrader.sqlite>", "account"?: "<name>" }` — required only by `get_trades`/`sync_trades`, loaded lazily. Copy `ninjatrader.config.example.json` (tracked) to create it; see [SETUP.md](SETUP.md). |
| `data/lab-calibration.json` | yes | Experiment ETA calibration data. |
| `data/sample/*.csv` | yes | 15m fixtures for `npm run seed`. |

### NT8 side setup

1. Copy `ninja-addon/addons/mcp-bridge.cs` into `Documents/NinjaTrader 8/bin/Custom/AddOns/` and the three indicator files into `.../bin/Custom/Indicators/`, then compile in the NinjaScript Editor. (`mcp-sma.cs` additionally needs the generated `SMAConfig.generated.cs` from the private build.)
2. Create `Documents/NinjaTrader 8/bridge.config.json`:
   ```json
   { "token": "<value of NT_BRIDGE_TOKEN from .env.local>", "url": "ws://127.0.0.1:9472" }
   ```
3. On AddOn load, check the NinjaScript Output window (tab 1): it lists your installed Trading Hours templates and warns if any mapped template name is missing (the AddOn maps e.g. `cme_us_index_futures_eth` → "CME US Index Futures ETH" and **fails closed** on candle requests without a valid template — it never silently falls back to RTH).
4. Attach `McpBridgeRenderer` to every chart you want the server to draw on. Attaching registers the chart's symbol with the AddOn; retained drawings replay automatically when a chart reloads.

The AddOn serves candle requests for 5m and 15m bars only, resolves the nearest non-expired contract for a symbol, and reconnects with exponential backoff (1s → 30s) if the bridge goes down.

---

## Development

```bash
npm test           # vitest, one-shot
npm run test:watch
npm run typecheck  # requires src/private/
npm run inspect    # MCP inspector against the built server
```

Vitest picks up `test/` plus co-located `__tests__/` under `src/tools/`, `src/lab/`, `src/adapters/`, `src/core/`, `src/bridge/`, and — when present — `src/private/tests/`. Tests run against a throwaway `.test-data/` DB, never `data/candles.db`.

Most tool handlers follow a factory + register pattern (`createXHandler(deps)` for dependency-injected testing, `registerX(server)` to wire real deps); the five lab tools instead call the `lab` singleton from `src/lab-instance.ts` directly. To add a new tool with the testing pattern, copy the shape of `src/tools/draw.ts`.

Public test coverage highlights: bridge wire protocol round-trips, candle aggregation across session/DST boundaries, session-day math, cache gap-fill planning and validation, the `get_candles` fail-closed gate, `resolve_session_days` anchors, drawing tools, execution pairing and trade ingest, the NinjaTrader SQLite reader, lab lifecycle + restart recovery, and bundle mapping. (`test/decision-tools.test.ts` imports private-backed tools and needs `src/private/` to load.)

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
  index.ts             MCP server entry — registers all 18 tools, starts the bridge
  bridge/              WS server, wire protocol, auth, connection manager, candle ingest
  core/                sessions (session-day math, templates, registry), aggregator,
                       time/ET helpers, cache fill + validator, instruments
  db/                  SQLite connection, schema, ledger DAO
                       (candles + trades + decisions share data/candles.db)
  tools/               MCP tool handlers
  lab/                 generic experiment orchestrator (store, runner port,
                       observability, integrity, diff) — engine-agnostic
  lab-instance.ts      binds the lab to this repo (runner, lab.db, backtest-results/)
  adapters/
    ninjatrader/       detached backtest-runner adapter + result-bundle mapper
  trade-source/        NinjaTrader.sqlite reader, execution pairing, ingest
  scripts/             ops scripts + fake-NT dev harnesses
  private/             (gitignored) proprietary decision/zone/SMA engine + strategies
ninja-addon/
  addons/              NT8 AddOn (McpBridge — WS client, candle server, draw store)
  indicators/          McpBridgeRenderer, McpSma, McpSmaSnapshot
test/                  vitest suites for public infrastructure
data/
  sample/              tracked seed fixtures
  candles.db, lab.db   created at runtime (gitignored)
backtest-results/      (gitignored) per-experiment run bundles
docs/                  (gitignored) local design docs and specs
```

---

## License

MIT.
