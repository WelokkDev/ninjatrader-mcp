# Algo trading with Python over `/feed`

The MCP hub has a WebSocket channel for local bots, `ws://127.0.0.1:9472/feed`.
Live bars come in and orders go out through it, and every order passes the same
gated write path as Claude's `place_order` tool. This folder is a working
starting point for a Python bot built on it.

| File | What it is |
|---|---|
| `live_feed_client.py` | A ~100-line asyncio script that prints bars as they close. Run it first to check the pipe. |
| `feed_client.py` | Reusable client: reconnect with backoff, re-subscribe, request/reply, position broadcasts. |
| `nt8_broker.py` | Managed bracket orders: entry → fill → stop/target OCO priced from the actual fill, fail-closed throughout. |
| `bracket_bot.py` | A runnable bot wiring the two together, with a toy breakout signal. |

```
your bot ──ws /feed──▶ MCP hub ──ExecutionService gates──▶ NT8 AddOn gate ──▶ account
         ◀── bars, order/fill events ──┘
```

A bot gets no shortcut: `/feed` orders hit the same three fail-closed gates,
the same account allow-list and the same audit trail as tool orders
([TRADING.md](../../TRADING.md)).

## Setup

1. Python 3.10+, then `pip install -r requirements.txt`.
2. The hub running (`npm start`, or any Claude conversation attached to the
   MCP server) and NT8 connected to a data feed (see [SETUP.md](../../SETUP.md)).
3. Nothing else. The token and address are read from the repo's `.env.local`
   (`NT_BRIDGE_TOKEN`, plus `NT_BRIDGE_HOST` / `NT_BRIDGE_PORT` when NT8 runs in a
   VM), and environment variables override them. `NT_FEED_URL` overrides the
   whole URL.

## Run the bot

Start in signals mode. It subscribes, prints every closed bar and what it
would place, and sends nothing:

```bash
python bracket_bot.py MNQ --timeframe 15s
```

```
11:41:48 feed connected (ws://127.0.0.1:9472/feed)
11:41:48 signals only on MNQ 15s — no orders (add --armed to trade)
11:42:00 subscribed MNQ 15s: live contract=MNQ DEC26
11:42:14 bar 11:42:15 O 30573 H 30579.25 L 30570 C 30577.5
11:42:14 [signal] would place buy stop @ 30579.5, stop 30569.75, target 2.0R from the fill
```

To send real orders on a sim account:

1. **Enable the write path**: follow [TRADING.md → Enabling it](../../TRADING.md#enabling-it-simpaper-first),
   covering `.env.local`, `trading.config.json` and the AddOn recompile. Keep the
   allow-list at `Sim101` while you're testing.
2. **Turn on the position feed**: ask Claude to run `subscribe_live_positions`.
   Fills come back as broadcasts on that feed, so the broker is blind without it.
3. Run it armed:

   ```bash
   python bracket_bot.py MNQ --timeframe 15s --armed --account Sim101
   ```

Before arming, the bot checks with NT8 and refuses to start if the position feed
is off, if NT8 can't name a tradable front-month contract, or if the account
already holds a position or has working orders on that symbol. Ctrl+C cancels
a working entry and flattens an open trade.

The signal is a toy that only exists to exercise the order path. Each bar arms a
buy stop one tick above its high, with the stop one tick below its low and the
target 2R from the fill. An entry that doesn't trigger by the next bar is
cancelled.

## Using the broker in your own bot

```python
bars = queue.Queue()
client = FeedClient(subscriptions=[("MNQ", "5m")], bar_queue=bars, subscribe_positions=True)
broker = Nt8Broker(transport=client, account="Sim101", symbol="MNQ",
                   tick_size=0.25, id_prefix="mybot-001")
client.on_broadcast = broker.handle_broadcast
client.start(); client.wait_connected(10); broker.start()

while True:
    msg = bars.get()
    for event in broker.drain(market_price=msg["candle"]["close"]):
        ...  # entry_fill, protection_placed, stop_fill, target_fill, flatten_fill, cancelled
    if msg.get("backfill"):
        continue
    if my_signal(msg):
        broker.submit(Bracket(direction="long", entry_type="limit", entry_price=...,
                              stop_price=..., target_rr=2))
```

What the broker guarantees, and what it asks of you. The rules in
[TRADING.md](../../TRADING.md) apply unchanged: an ack is not a fill, and
`flatten` is instrument-wide, so it also cancels orders you placed by hand.

- **Protection is priced from the actual fill**, and the OCO goes out the moment
  the fill broadcast arrives. `target_rr` measures risk from the real fill, and
  `target_price` fixes the level up front.
- **It fails closed.** It flattens and reports `CRITICAL` if protection can't be
  placed, is rejected, or is cancelled by anyone else, and also if a fill arrives
  with no price or lands at or through the stop. It never holds an unprotected
  position and never guesses a fill price.
- **Ambiguous means ambiguous.** A timeout or dropped socket might mean the order
  went through or might not. The broker reports it, keeps watching that order's
  events, and never retries on its own.
- **Resting entries are checked first.** A buy limit at or above the last price,
  or a buy stop at or below it, would fill at once instead of resting, so it is
  refused before it reaches NT8. Pass each bar close to `drain()` so the check
  has a price.
- **Reconciliation.** After a reconnect or a server resync, the broker re-reads
  the account and settles anything it missed. A fill that happened unseen, and
  so has no protection, gets flattened.
- **Scope.** One broker per (account, symbol). Quantity is 1, because partial
  fills aren't handled. TIF is Day, so a dead bot leaves nothing working
  overnight.
- **Order names.** Entries are named `<prefix>-<n>E` and OCO legs
  `<prefix>-<n>:S` / `:T`. NT8 drops a repeated name as a duplicate, so use a new
  `id_prefix` every run.

## Protocol cheat sheet

All frames are JSON text. Requests carry a `reqId`, and the reply is
`<type>_result` with the same `reqId`. `FeedClient.request()` handles the pairing.

| You send | You get back |
|---|---|
| `subscribe {symbol, timeframe}` | `subscribed {ok, upstream: {acked, contract, error}}`, then `bar` frames |
| `unsubscribe {symbol, timeframe}` | `unsubscribed` |
| `subscribe_positions` | `subscribed_positions {feedDesired, feedUpstreamAcked}`, then broadcasts |
| `place_order {account, symbol, action, orderType, quantity, tif, clientOrderId, limitPrice?, stopPrice?}` | `place_order_result {ok, state, …}` or `{ok: false, error, certainlyNotSubmitted?}` |
| `place_oco {account, symbol, action, quantity, stopPrice, limitPrice, tif, clientOrderId}` | `place_oco_result` (legs are `<id>:S`, `<id>:T`) |
| `change_order`, `cancel_order`, `cancel_all`, `flatten` | `<op>_result` |
| `sync_positions {account?, fresh?}` | positions and working orders per account |
| `resolve_instrument {symbol}` | the contract the symbol binds to right now, and whether that's attested |
| `ensure_bars {symbol, timeframe, fromUnix, toUnix}` | the server fills its cache for that range from NT8 |

`subscribe` starts the upstream NT8 stream itself, so a bot needs no
`subscribe_live_bars` call first.

Broadcasts (after `subscribe_positions`): `position_event` with
`kind` = `order` | `execution` | `position`, `position_sync` (re-read the
account), and `trade_closed`.

Live timeframes are `1s`, `5s`, `15s`, `5m` and `15m`. Order types are
`Market`, `Limit`, `Stop` and `StopLimit`, and TIF is `Day`, `Gtc` or `Ioc`.

## Things that bite

- **Bar timestamps are the bar's close time** (NT8's convention). On `1s` to
  `15s`, a bar only exists if the bucket traded, so a quiet market means gaps,
  not an outage.
- **Skip `backfill: true` bars.** They closed well before delivery, as catch-up
  after a reconnect, and acting on them means acting on stale prices.
- **Missed bars are not replayed over the socket.** The hub saves every bar to
  its SQLite cache (`data/candles.db`) *before* broadcasting it, and repairs gaps
  into that same cache. A bot on the same machine can use each `bar` message as
  a doorbell and read everything since its last bar straight from the cache
  (open it read-only; a query takes about 0.1 ms):

  ```sql
  SELECT timestamp, open, high, low, close, volume FROM candles
  WHERE symbol = ? AND timeframe = ? AND timestamp > ? AND timestamp <= ?
  ORDER BY timestamp
  ```

  Otherwise, call `ensure_bars` for the gap and read it with `get_candles`.
- **Compare timestamps from one clock.** Bar stamps come from NT8, while
  `time.time()` comes from your machine. With NT8 in a VM those two clocks can
  be a second apart; in the sample run above, the bar stamped 11:42:15 arrived at
  11:42:14 local time.
- **Where order latency goes.** On a Parallels setup, submit → NT8 ack measured
  roughly 60–360 ms, almost all of it the trip into the VM and NT8 itself. The
  Python side and the cache read are a few milliseconds at most.

## Next

Copy these files into your own module and replace the signal. Private strategy
code belongs in `src/private/`; see [BUILD-YOUR-OWN.md](../../BUILD-YOUR-OWN.md).

For an engine where the strategy you backtest is the one you run live, see
[bedivere](https://github.com/WelokkDev/bedivere). It leaves the feed and the
broker as ports, and these files are a starting point for both.
