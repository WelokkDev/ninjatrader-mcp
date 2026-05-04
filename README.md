# ninjatrader-mcp

MCP server bridging Claude Code to NinjaTrader 8 for futures zone detection and trade journaling.

The MCP server runs locally and exposes tools (`get_candles`, `draw_zone`, `clear_zones`, …) to Claude. A WebSocket bridge connects to the NT8 AddOn (`ninja-addon/addons/mcp-bridge.cs`); a companion indicator (`ninja-addon/indicators/mcp-renderer.cs`) renders zones onto charts.

## Build and run

```bash
npm install
npm run build
npm start
```

The server creates `data/candles.db` (SQLite, WAL mode) on first run and listens for the NT8 AddOn on `ws://127.0.0.1:9472`. The bridge token is generated automatically and written to `.env.local`; paste it into NT8's `bridge.config.json` (in `Documents/NinjaTrader 8/`).

## Development — running tests

```bash
npm test         # one-shot
npm run test:watch
```

Vitest runs from the `test/` directory and covers four areas:

| File | What it exercises |
| --- | --- |
| `test/aggregator.test.ts` | `aggregateCandles` — clock-aligned 30m/1h, session-aligned 4h, day-boundary handling, output sort order |
| `test/protocol.test.ts` | `parseMessage` round-trip for every inbound message type, plus rejection cases (bad JSON, wrong version, malformed candles); `encode` for the two outbound zone messages |
| `test/get-candles.test.ts` | The `get_candles` tool's cache-hit path against an in-memory SQLite, plus arg-validation paths (unsupported symbol, malformed dates, disconnected bridge) |
| `test/zone-tools.test.ts` | `draw_zone` and `clear_zones` tools dispatch the correct outbound message shape, including the optional `fromTs`/`toTs` and `ids` semantics |

The MCP tool handlers are factory-style (`createGetCandlesHandler`, `createDrawZoneHandler`, `createClearZonesHandler`) — `register*` wires the real bridge/db deps; tests inject mocks. To add a new tool with the same testing pattern, copy the factory shape from `src/tools/draw-zone.ts`.

## Project layout

```
src/
  bridge/         WebSocket server, protocol types, connection manager
  core/           pure helpers — aggregator, types, constants
  db/             SQLite connection and schema
  scripts/        manual fake-NT scripts and DB seed
  tools/          MCP tool handlers (factory + register pair per tool)
ninja-addon/
  addons/         NT8 AddOn (McpBridge — WebSocket client, request_candles)
  indicators/     NT8 chart indicator (McpBridgeRenderer — Draw.Rectangle)
test/             vitest test suite
```
