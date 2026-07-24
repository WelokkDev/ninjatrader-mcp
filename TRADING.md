# Order placement & management (the write path)

This repo can **submit and manage orders** in NinjaTrader, not just observe. It
is **default-off** and gated at three independent layers, and it fails closed
at every one. Nothing here reaches a broker until you deliberately turn it on.

The write logic lives in one reusable place — `ExecutionService`
(`src/execution/service.ts`): `submit()`, `submitOco()`, `cancel()`,
`cancelAll()`, `flatten()`, `change()`. The MCP tools are thin adapters over
it; the future Python algo will call the same gateway over a local RPC, so
there is exactly one code path that ever touches an order.

> **Phase 2 (now):** single orders (Market / Limit / Stop / StopLimit;
> Day / Gtc / Ioc), OCO **exit pairs** (`place_oco`), in-place amends
> (`change_order`), and the risk-reducing ops `cancel_order` / `cancel_all` /
> `flatten`. **No FOK:** NT8's `TimeInForce` has no FOK value (verified against
> the installed assemblies) — Ioc is the closest primitive, and FOK is not
> emulated. **No ATM strategies and no trailing-stop order type** — NT8 has no
> trailing `OrderType`; trailing is agent behavior (repeated `change_order` on
> the stop leg).

## What an ack means (read this)

A success ack from any write tool means **NT8 accepted the request call** — it
is never proof of the outcome. Per op:

- **`place_order` / `place_oco`** — accepted the submit; **not a fill**, not
  broker-accept. The order can still be rejected asynchronously (margin, price,
  market closed).
- **`cancel_order`** — accepted the cancel *request* (state e.g.
  `CancelSubmitted`); the order is gone only when you see `Cancelled`. **A fill
  can beat the cancel** — an `already-terminal` error tells you which way it
  went (`Filled` vs `Cancelled`). Partial fills keep the filled portion.
- **`change_order`** — accepted the amend *request* (`ChangeSubmitted`); the
  new values are live only when the order events confirm them.
- **`cancel_all` / `flatten`** — accepted the instrument-wide request; verify
  with `get_positions` that nothing is left working (and, for flatten, that the
  position is flat).

Confirm real outcomes with `get_positions` or the live position feed. On an ack
**timeout**, the request **may still have been dispatched**: for placements, do
not blindly retry — check positions first and reuse the returned
`clientOrderId` if you do retry; cancel/change/flatten are idempotent, so
retrying those is safe.

## Risk-adding vs risk-reducing (locked policy, 2026-07-23)

The six write ops split into two policy classes, applied identically on **both**
gate layers (TS and C#):

- **Risk-adding — `place_order`, `place_oco`, `change_order`:** full gate
  (enabled + allow-list + qty cap + rate limit). `change_order` is risk-adding
  because a widened stop or raised quantity adds exposure; `place_oco` because
  a triggered "exit" stop on a flat account **opens** a position.
- **Risk-reducing — `cancel_order`, `cancel_all`, `flatten`:** gated by the
  **account allow-list only**. They keep working when `enabled=false` and are
  exempt from the qty cap and the rate limit, because they strictly reduce
  exposure — a kill-switch or a full rate window must never strand a working
  order or an open position. (User decision, 2026-07-23 — do not relitigate.)

Registration matrix (decided at startup):

| Config at startup                   | place_order / place_oco / change_order | cancel_order / cancel_all / flatten |
| ----------------------------------- | -------------------------------------- | ----------------------------------- |
| enabled, accounts allow-listed      | registered                             | registered                          |
| **disabled**, accounts allow-listed | absent                                 | **registered** (kill-switch case)   |
| no accounts allow-listed            | absent                                 | absent                              |

## The three gates (all fail-closed)

1. **Tool registration (TS, startup).** The risk-adding tools are only added to
   the MCP surface when trading is enabled at startup; the risk-reducing tools
   whenever any account is allow-listed (see the matrix above). Off ⇒ the tool
   does not exist for Claude at all, in any mode. Re-enabling requires a server
   restart (deliberate); disabling can be done live.
2. **Runtime gate (TS, per call).** `ExecutionService` re-reads the config on
   every call and enforces the op's policy class (full gate vs allow-list
   only). Read fresh, so editing `.env.local` toggles it live.
3. **AddOn gate (C#, per request) — the keystone.** The NinjaScript AddOn reads
   its **own** config file immediately before every NT8 call and rejects
   otherwise, applying the same risk-adding/risk-reducing split. Because there
   is no C# compiler on the trading machine, this gate cannot be recompiled
   away by an agent. It also **dedupes** repeated `clientOrderId`s (including
   OCO leg names) so a retry never double-fires, and **tick-rounds** prices
   before use, echoing the effective values in the ack.

The AddOn advertises its supported write ops in the hello `caps` field; when a
tool is called that the connected AddOn build doesn't support (deploy skew —
new server, old AddOn), the server fails fast with a "recompile mcp-bridge.cs"
message instead of a 10-second ambiguous timeout.

Every attempt that reaches `ExecutionService` is written to the audit trail —
placements (including each OCO leg, linked by `oco_group`) to the
`order_submissions` table, management ops to the `order_ops` table
(`dispatched` / `blocked` / `failed`). The
NT8 Output window (tab 1) only shows attempts that reach the **C# keystone**
(dispatched, AddOn-gate blocked, or an NT8-call failure). A **TS-side block**
(runtime gate, validation, not-connected) never crosses the bridge, so it
appears in the audit table but **not** in the NT8 Output window. (And with the
registration gate off, the tool does not exist, so there is nothing to attempt.)

## Managing orders

The bracket workflow, end to end:

1. **Enter** with `place_order` (e.g. Buy 1 MNQ Market). Watch `get_positions`
   / the position feed for the **fill** — the ack is not it.
2. **Protect** with `place_oco`: one call places the protective stop
   (StopMarket at `stopPrice`) and the profit target (Limit at `limitPrice`) as
   an atomic OCO pair — shared action (the exit side), quantity, and tif; when
   one leg fills or terminates, NT8 cancels the sibling. There is no naked
   window between the two exit orders, only between the entry fill and step 2 —
   do it promptly.
3. **Trail** with `change_order` on the stop leg (`<base>:S`): repeated
   `stopPrice` amends keep the order working the whole time. Prefer this over
   cancel+replace — no unprotected gap, and queue position is kept where the
   change allows. Prices are tick-rounded; the ack echoes effective values.
   Note: `change_order` is **risk-adding** (a widened stop or raised qty adds
   exposure), so it rides the full gate including the rate limit — a rapid trail
   loop can be throttled (`blockedBy: "rate-limited"`, `certainlyNotDispatched`),
   which leaves the stop at its last accepted value, NOT wherever you last tried
   to move it. If you must cut risk while the rate window is full, use
   `cancel_order` / `flatten` — they are risk-reducing and never rate-limited.
4. **Abort** with `cancel_order` (one order, by `clientOrderId`),
   `cancel_all` (every working order for the instrument), or `flatten`
   (cancel everything AND close the position at market — the panic button).

Sharp edges to keep in mind:

- **`cancel_all` and `flatten` are instrument-wide on the account** — they
  cancel **manually placed orders too**, not just orders this server placed.
  `flatten` also closes the position at market, accepting slippage.
- **OCO leg ids are derived**: `place_oco` returns a base `clientOrderId`;
  the legs are `<base>:S` (stop) and `<base>:T` (target). Address a leg (for
  `change_order` / `cancel_order`) by its leg id.
- **Cancelling one OCO leg cancels the sibling too** (a cancel is a terminal
  state). You cannot turn the bracket into a bare stop by cancelling the
  target — you would lose both legs. To keep protection while removing the
  target, place a fresh single stop first, then cancel the pair.
- **Retry rules:** placements are deduped by `clientOrderId` — reuse the id
  only to retry an ambiguous result. Cancel/change/flatten are idempotent —
  retrying them is always safe.

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

`ninja-addon/addons/mcp-bridge.cs` carries all six write handlers. In the
NinjaScript Editor press **F5** to compile, then confirm in the **Output
window (tab 1)** that the bridge reconnected and the server log shows the
hello `caps` list. (See CLAUDE.md — copying/compiling NinjaScript is always
the developer's own step.) Before recompiling after a server update, calling a
new tool should fail fast with a "recompile mcp-bridge.cs" message — that is
the deploy-skew detection working, not a bug.

### Turning it OFF

Set `NT_TRADING_ENABLED=0` in `.env.local` (runtime gate blocks risk-adding
ops immediately) and `"enabled": false` in `trading.config.json` (AddOn gate
likewise). **The risk-reducing tools stay live on purpose** — with everything
disabled you can still cancel and flatten, you just can't add exposure. To
remove the risk-adding tools from the surface, restart the server with
`NT_TRADING_ENABLED=0`; to remove every write tool, also clear
`NT_TRADING_ALLOW_ACCOUNTS`.

## Known limitations (phase 2)

- **No net-exposure or working-order cap yet.** `maxQty` is enforced **per
  order**, not across orders. Rate × qty can still build a larger position
  inside a minute (e.g. 6 orders/min × 2 = 12 contracts), all individually
  in-policy. The planned exposure gate (`maxPosition` / `maxWorkingOrders` in
  both gate layers) is **not built yet** and is a hard prerequisite before any
  live account is allow-listed.
- **Naked window between entry fill and `place_oco`.** The entry and its
  bracket are still separate calls; place the OCO pair as soon as you see the
  fill, and do not walk away in between. (Server-side auto-brackets are a
  possible phase 3.)
- **No FOK** (NT8 has none — Ioc is the closest primitive), **no ATM
  strategies, no trailing-stop order type** (trail by repeated `change_order`).
  These are exclusions by design, not gaps.

The first item is safe-by-omission on Sim, but treat it as a blocker for live.
