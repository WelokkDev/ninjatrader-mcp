# Order placement (the write path)

This repo can **submit orders** to NinjaTrader, not just observe. It is
**default-off** and gated at three independent layers, and it fails closed at
every one. Nothing here reaches a broker until you deliberately turn it on.

The submit logic lives in one reusable place — `ExecutionService.submit()`
(`src/execution/service.ts`). The `place_order` MCP tool is a thin adapter over
it; the future Python algo will call the same gateway over a local RPC, so
there is exactly one code path that ever places an order.

> **Phase 1 (now):** single flat orders — Market / Limit / Stop / StopLimit,
> entry or exit — on an allow-listed account. **No brackets yet:** place a
> protective stop/target as its own order after you see the entry fill
> (`get_positions` already computes dollar risk / R once the stop is working).

## What an ack means (read this)

A success from `place_order` means **NT8 accepted the submit call** — it is
**not a fill** and **not proof the exchange took the order**. The order can
still be **rejected asynchronously** (margin, price, market closed). Confirm the
real outcome with `get_positions` or the live position feed. On an ack
**timeout**, the order **may still have been submitted** — do not blindly
retry; check positions first.

## The three gates (all fail-closed)

1. **Tool registration (TS, startup).** `place_order` is only added to the MCP
   surface when trading is enabled at startup. Off ⇒ the tool does not exist for
   Claude at all, in any mode. Re-enabling requires a server restart
   (deliberate); disabling can be done live.
2. **Runtime gate (TS, per call).** `ExecutionService` re-reads the config on
   every submit and enforces enabled + account allow-list + per-order qty cap +
   a rolling rate limit. Read fresh, so editing `.env.local` toggles it live.
3. **AddOn gate (C#, per submit) — the keystone.** The NinjaScript AddOn reads
   its **own** config file immediately before `Submit()` and rejects otherwise.
   Because there is no C# compiler on the trading machine, this gate cannot be
   recompiled away by an agent. It also **dedupes** repeated `clientOrderId`s so
   a retry never double-fires.

Every attempt — allowed, blocked, or failed — is written to the
`order_submissions` table (audit) and to the NT8 Output window (tab 1).

## Enabling it (sim/paper first)

### 1. TS side — add to `.env.local` (repo root, gitignored)

```
NT_TRADING_ENABLED=1
NT_TRADING_ALLOW_ACCOUNTS=Sim101
NT_TRADING_MAX_QTY=2
NT_TRADING_MAX_ORDERS_PER_MIN=6
```

Defaults are fail-closed: unset ⇒ disabled, empty allow-list, qty cap 0. Then
**restart the MCP server** (registration is decided at startup).

### 2. C# side — create `trading.config.json` in the NT8 user-data dir

Same folder as `bridge.config.json` (NinjaTrader's `Globals.UserDataDir`,
typically `Documents/NinjaTrader 8/`):

```json
{ "enabled": true, "allowAccounts": ["Sim101"], "maxQty": 2 }
```

Missing or unparseable ⇒ the AddOn treats the write path as disabled.

### 3. Recompile the AddOn (your step — never done for you)

`ninja-addon/addons/mcp-bridge.cs` gained the `place_order` handler. In the
NinjaScript Editor press **F5** to compile, then confirm in the **Output
window (tab 1)** that the bridge reconnected. (See CLAUDE.md — copying/compiling
NinjaScript is always the developer's own step.)

### Turning it OFF

Set `NT_TRADING_ENABLED=0` in `.env.local` (runtime gate blocks immediately) and
`"enabled": false` in `trading.config.json` (AddOn gate blocks immediately). To
fully remove the tool, restart the server with `NT_TRADING_ENABLED=0`.
