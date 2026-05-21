# ninjatrader-mcp

MCP server bridging Claude Code to NinjaTrader 8 for futures candle access, zone detection, and chart annotation.

The MCP server runs locally, exposes tools to an MCP client (e.g., Claude), and maintains a WebSocket bridge to the NT8 AddOn. The AddOn streams bar-close events back, answers candle requests, and renders zone rectangles onto charts.

---

## Status — work in progress

This is a personal trading-research project under active development. The **public / private split is currently weak**: most of the proprietary trading logic (zone detection, the quantifier pipeline, strategy configurations) lives in a separate gitignored module at `src/private/`. The infrastructure pieces — the bridge, the candle cache, the chart-annotation tools, the NT8 AddOn — are all here in the public repo.

What this means today:

- **Works on this public repo alone:** `get_candles`, `draw_zone`, `clear_zones`. They only touch the bridge, the SQLite cache, and NT8.
- **Does not work on this public repo alone:** `scan_zones`. `src/tools/scan-zones.ts` imports the detector, pipeline, quantifier registry, types, and strategy loader from `src/private/waw/*`, and reads strategy JSON files from `src/private/waw/strategies/`. Without that module on disk, `npm run build` will fail with missing-import errors.

The plan to amend this:

1. **Refactor `scan_zones` along with future tools/services dependent on private module to a public-only seam.**
2. **Ship a private module template.** So external developers can plug in their own methodology.
3. **Document the boundary contracts** — `Strategy`, `Quantifier`, `Indicator`, `MarketContext`, the bridge wire protocol — as the seam between public infrastructure and proprietary trading logic.

Until that work lands, treat anything referencing `src/private/` as a private dependency you cannot satisfy from this repo.

---

## Architecture

```
                       ┌──────────────────────────┐
                       │  Claude (MCP client)     │
                       └────────────┬─────────────┘
                                    │  MCP over stdio
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │  ninjatrader-mcp (Node.js process)                     │
       │                                                        │
       │   MCP tools (src/tools/)                               │
       │   ├─ get_candles    OHLCV from cache; auto-fill on miss│
       │   ├─ scan_zones     zone detection (REQUIRES PRIVATE)  │
       │   ├─ draw_zone      draw a price box on NT8 chart      │
       │   └─ clear_zones    remove drawn boxes                 │
       │                                                        │
       │   Bridge (src/bridge/)                                 │
       │   - WebSocket server on 127.0.0.1:9472                 │
       │   - Bearer-token auth (token in .env.local;            │
       │     auto-generated on first run, logged to stderr)     │
       │   - One active client at a time (the NT8 AddOn)        │
       │                                                        │
       │   SQLite cache (src/db/, data/candles.db, WAL)         │
       │   - OHLCV bars keyed by (symbol, timeframe, timestamp) │
       │   - Session-day-aware gap-fill via NT8                 │
       │                                                        │
       │   src/private/  (gitignored, proprietary)              │
       │   └─ detector + pipeline + scoring modules +           │
       │      strategy configs                                  │
       └────────────────────────────▲───────────────────────────┘
                                    │  WebSocket
                                    │  ▲  hello, heartbeat,
                                    │  │  candles_response, bar_close
                                    │  ▼  draw_zone, clear_zones,
                                    │     request_candles, hello_ack
                                    │
       ┌────────────────────────────┴───────────────────────────┐
       │  NinjaTrader 8 (Windows)                               │
       │  ├─ ninja-addon/addons/mcp-bridge.cs                   │
       │  │  (WebSocket client; bar streaming; candle requests) │
       │  └─ ninja-addon/indicators/mcp-renderer.cs             │
       │     (chart indicator that renders zone rectangles)     │
       └────────────────────────────────────────────────────────┘
```

### Data flow

1. **MCP client → server (stdio).** Claude invokes a tool. Tool handlers run in-process in the Node MCP server.
2. **Server ↔ NT8 (WebSocket).** The bridge runs a local WebSocket server. NT8 (via the McpBridge AddOn) connects out to it with `Authorization: Bearer <token>`. The bridge listens only on `127.0.0.1` — there is no externally reachable surface.
3. **Server ↔ cache (SQLite).** All bars NT8 returns get persisted to `data/candles.db`. `get_candles` auto-fills any session-day gap in the requested range by issuing `request_candles` to NT8, then serves from cache.
4. **`scan_zones` ↔ private module.** When `scan_zones` runs, it reads cached candles, loads a strategy JSON from `src/private/waw/strategies/`, and runs the quantifier pipeline defined in `src/private/waw/`. The strategy decides which quantifiers run and how they're configured.

### The connection is not an inbound webhook

NT8 is the WebSocket *client*; the MCP server is the *server*. The AddOn dials out to `ws://127.0.0.1:9472` with the shared bearer token; nothing reaches in from the internet. The token is created on first server start, written to `.env.local`, and printed once to stderr so you can paste it into NT8's `bridge.config.json` (under `Documents/NinjaTrader 8/`). Subsequent restarts reuse the existing token.

---

## Public / private module map

### Public modules (this repo)

| Path | Role |
|---|---|
| `src/index.ts` | MCP server entry; registers tools and starts the bridge. |
| `src/tools/` | MCP tool handlers — factory + `register*` pair per tool. |
| `src/bridge/` | WebSocket server, bearer-token auth, connection manager, wire protocol. |
| `src/db/` | SQLite schema and connection (candle cache). |
| `src/core/` | Cross-cutting helpers: time / ET formatting, session-day math, candle aggregation, instrument templates. |
| `src/scripts/` | Manual ops scripts (rebuild bars, dump bars, audit bars, seed). |
| `ninja-addon/addons/` | NT8 AddOn (`mcp-bridge.cs`) — WebSocket client, bar streaming, candle request handler. |
| `ninja-addon/indicators/` | NT8 chart indicator (`mcp-renderer.cs`) — renders zone rectangles via `Draw.Rectangle`. |

### Private modules (gitignored; required by `scan_zones`)

The shape of the private module, without the contents:

- A **detector** that produces candidate zones from cached candles.
- A **pipeline** that runs every enabled scoring module on each zone and aggregates per-module rollup stats.
- A set of **scoring modules**, each evaluating one dimension of a zone.
- A **strategy loader** that parses strategy JSON and validates per-module config at load time.
- **Strategy JSON files** that pick which modules run and configure each.

The specific scoring methodology, module names, and config fields are proprietary and not documented here.

---

## How `scan_zones` operates (shape only)

A strategy JSON file declares which scoring modules run and configures each. The pipeline runs every enabled module on every detected zone (no short-circuit), so each zone ends up with one score per module plus an aggregate pass/fail flag. `scan_zones` optionally narrows the returned set via `scoreFilters` (per-module acceptance windows) and optionally draws the survivors on the connected NT8 chart via `draw: true`. The full parameter surface lives in `src/tools/scan-zones.ts`.

---

## Build and run

```bash
npm install
npm run build
npm start
```

On first run, the server creates `data/candles.db` (SQLite, WAL mode), generates a bearer token, writes it to `.env.local`, and prints it to stderr. Paste that token into NT8's `bridge.config.json` (in `Documents/NinjaTrader 8/`), then start NT8 with the McpBridge AddOn enabled. The AddOn will dial the bridge and the connection will come up.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `NT_BRIDGE_TOKEN` | (auto-generated, persisted to `.env.local`) | Shared secret between server and NT8 AddOn. |
| `NT_BRIDGE_PORT` | `9472` | Local TCP port the bridge listens on. |

---

## MCP tools

| Tool | Requires private? | Summary |
|---|---|---|
| `get_candles` | No | Read OHLCV bars from the cache for a `(symbol, timeframe, start, end)`. On any session-day gap in the requested range, the missing days auto-fill from NT8 at raw timeframe (5m direct, others derived from 15m), then are served. |
| `scan_zones` | **Yes** | Detect zones over a cached candle range, run the strategy's quantifier pipeline, optionally filter survivors by per-quantifier `scoreFilters`, optionally auto-draw survivors on the NT8 chart via `draw: true`. |
| `draw_zone` | No | Draw a single price-box rectangle on the NT8 chart by id. |
| `clear_zones` | No | Remove zone rectangles previously drawn, by symbol and/or specific ids. |

---

## Development — running tests

```bash
npm test         # one-shot
npm run test:watch
npm run typecheck
```

Vitest runs tests from both `test/` (public infrastructure) and `src/private/tests/` (private engine). The MCP tool handlers are factory-style (`createGetCandlesHandler`, `createScanZonesHandler`, `createDrawZoneHandler`, `createClearZonesHandler`) — `register*` wires the real bridge/db deps; tests inject mocks. To add a new tool with the same testing pattern, copy the factory shape from `src/tools/draw-zone.ts`.

### Public test coverage

| File | What it exercises |
|---|---|
| `test/aggregator.test.ts` | `aggregateCandles` — clock-aligned 30m/1h, session-aligned 4h, day-boundary handling, output sort order. |
| `test/protocol.test.ts` | `parseMessage` round-trip for every inbound message type, plus rejection cases (bad JSON, wrong version, malformed candles); `encode` for outbound zone messages. |
| `test/get-candles.test.ts` | The `get_candles` tool's cache-hit path against an in-memory SQLite, plus arg-validation paths (unsupported symbol, malformed dates, disconnected bridge). |
| `test/zone-tools.test.ts` | `draw_zone` and `clear_zones` dispatch the correct outbound message shape, including optional `fromTs`/`toTs` and `ids` semantics. |
| `test/cache-fill.test.ts`, `test/cache-validator.test.ts` | Session-day-aware gap-fill, day-aligned overwrites, validator behavior. |
| `test/sessions/session-day.test.ts`, `test/time.test.ts` | Session-day math and ET formatting. |

---

## Project layout

```
src/
  bridge/           WebSocket server, protocol types, connection manager, auth
  core/             pure helpers — aggregator, types, constants, time, sessions
  db/               SQLite connection and schema, cache fill + validator
  scripts/          manual fake-NT scripts, DB seed, rebuild/dump/audit bars
  tools/            MCP tool handlers (factory + register pair per tool)
  private/          gitignored proprietary module (detector, pipeline, quantifiers, strategies)
ninja-addon/
  addons/           NT8 AddOn (McpBridge — WebSocket client, request_candles)
  indicators/       NT8 chart indicator (McpBridgeRenderer — Draw.Rectangle)
test/               vitest suite for public infrastructure
docs/
  prd/              in-progress design docs
  audit/            historical state snapshots
  design/           architecture notes
data/
  candles.db        SQLite candle cache (created on first run; gitignored)
```

---

## License

MIT.
