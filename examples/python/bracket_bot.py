"""A runnable bracket bot: FeedClient for bars, Nt8Broker for orders.

It is a wiring example, NOT a strategy — the signal only exists to exercise
the order path end to end (resting entry, cancel, fill, OCO, exits).

    pip install websocket-client
    python bracket_bot.py MNQ --timeframe 15s              # signals only, no orders
    python bracket_bot.py MNQ --timeframe 15s --armed      # real orders (see README.md)

Each closed bar arms a buy stop one tick above its high, with the stop one
tick below its low and the target --rr × risk from the actual fill. An entry
still unfilled at the next bar close is cancelled, and the bot re-arms on the
bar after. After --max-trades round trips it stops arming. Ctrl+C cancels a
working entry and flattens an open trade.
"""

from __future__ import annotations

import argparse
import queue
import sys
import time
from datetime import datetime
from typing import cast

from feed_client import FeedClient
from nt8_broker import Bracket, BrokerEvent, Nt8Broker

# Mirrors src/core/instruments/tick-size.ts; pass --tick-size for anything else.
TICK_SIZES = {
    "ES": 0.25, "NQ": 0.25, "YM": 1.0, "RTY": 0.1,
    "MES": 0.25, "MNQ": 0.25, "MYM": 1.0, "M2K": 0.1,
    "CL": 0.01, "GC": 0.1,
}  # fmt: skip
LIVE_TIMEFRAMES = ("1s", "5s", "15s", "5m", "15m")


def log(text: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {text}", flush=True)


def run_prefix() -> str:
    """Unique per run: NT8 dedupes on order names, so a reused name is a no-op."""
    n, digits = int(time.time()), ""
    while n:
        n, r = divmod(n, 36)
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + digits
    return f"bb{digits}"


# ---------- arming preflight ----------


def front_month_problem(reply: dict[str, object], symbol: str) -> str | None:
    if not reply.get("ok"):
        return f"could not resolve {symbol} on NT8: {reply.get('error')}"
    contract = reply.get("contract")
    if not contract:
        return f"NT8 resolved no contract for {symbol} — check Tools > Instruments"
    if not reply.get("attested"):
        return (
            f"the front month for {symbol} is a guess ({contract}) — NT8's rollover table "
            "could not be read, so the AddOn would refuse every order"
        )
    if not reply.get("tradable"):
        return f"{contract} is past its last trading day — NT8's rollover table is stale"
    return None


def account_problem(reply: dict[str, object], account: str, symbol: str) -> str | None:
    """Fail closed: a dirty or unknown account blocks arming."""
    if not reply.get("ok"):
        return f"sync_positions failed: {reply.get('error')}"
    if not (reply.get("feedDesired") and reply.get("feedUpstreamAcked")):
        return (
            "the position feed is OFF — without fill broadcasts the broker is blind. "
            "Run subscribe_live_positions in Claude first"
        )
    if not reply.get("pulled"):
        return f"could not pull fresh positions from NT8: {reply.get('pullError')}"
    for raw in cast(list[object], reply.get("accounts") or []):
        acct = cast(dict[str, object], raw)
        if acct.get("name") != account:
            continue
        for p in cast(list[dict[str, object]], acct.get("positions") or []):
            flat = p.get("marketPosition") == "Flat" or p.get("quantity") == 0
            if p.get("symbol") == symbol and not flat:
                return f"{account} already holds a {symbol} position — flatten it first"
        working = [
            str(o.get("name"))
            for o in cast(list[dict[str, object]], acct.get("orders") or [])
            if o.get("symbol") == symbol
        ]
        if working:
            return (
                f"working {symbol} orders on {account} ({', '.join(working)}) — cancel them first"
            )
        return None
    return f"account {account} is not in NT8's snapshot — is it connected?"


# ---------- the bot ----------


class BreakoutBot:
    def __init__(
        self, broker: Nt8Broker | None, *, tick: float, rr: float, max_trades: int
    ) -> None:
        self._broker = broker
        self._tick = tick
        self._rr = rr
        self._max_trades = max_trades
        self._active: int | None = None  # bracket id
        self._filled = False
        self._cancel_sent = False
        self._trades = 0

    def on_bar(self, msg: dict[str, object]) -> None:
        candle = cast(dict[str, float], msg["candle"])
        self.handle_events(candle["close"])
        stamp = datetime.fromtimestamp(candle["timestamp"]).strftime("%H:%M:%S")
        if msg.get("backfill"):
            log(f"bar {stamp} is a catch-up bar (closed well before delivery) — not acting on it")
            return
        log(
            f"bar {stamp} O {candle['open']} H {candle['high']} "
            f"L {candle['low']} C {candle['close']}"
        )
        if self._active is not None:
            if not self._filled and not self._cancel_sent:
                log(f"entry #{self._active} not triggered — cancelling")
                assert self._broker is not None
                self._broker.cancel(self._active)
                self._cancel_sent = True
            return
        if self._trades >= self._max_trades:
            return

        bracket = Bracket(
            direction="long",
            entry_type="stop",
            entry_price=candle["high"] + self._tick,
            stop_price=candle["low"] - self._tick,
            target_rr=self._rr,
            tag=f"breakout of {stamp} bar",
        )
        if self._broker is None:
            log(
                f"[signal] would place buy stop @ {bracket.entry_price}, "
                f"stop {bracket.stop_price}, target {self._rr}R from the fill"
            )
            return
        self._active = self._broker.submit(bracket)
        self._filled = False
        self._cancel_sent = False
        log(f"entry #{self._active}: buy stop @ {bracket.entry_price}, stop {bracket.stop_price}")

    def handle_events(self, market_price: float | None = None) -> None:
        if self._broker is None:
            return
        for ev in self._broker.drain(market_price):
            self._log_event(ev)
            if ev.bracket_id != self._active:
                continue
            if ev.kind == "entry_fill":
                self._filled = True
            elif ev.kind in ("stop_fill", "target_fill", "flatten_fill"):
                self._trades += 1
                self._active = None
            elif ev.kind == "cancelled":
                self._active = None

    def shutdown(self) -> None:
        if self._broker is None or self._active is None:
            return
        if self._filled:
            log("flattening the open trade")
            self._broker.flatten()
        else:
            log(f"cancelling working entry #{self._active}")
            self._broker.cancel(self._active)
        deadline = time.monotonic() + 5.0
        while self._active is not None and time.monotonic() < deadline:
            time.sleep(0.25)
            self.handle_events()
        if self._active is not None:
            log(f"WARNING bracket #{self._active} did not settle — check NT8")

    @staticmethod
    def _log_event(ev: BrokerEvent) -> None:
        detail = {
            "entry_fill": f"filled @ {ev.price}",
            "protection_placed": f"OCO placed: stop {ev.stop_price}, target {ev.target_price}",
            "stop_fill": f"stopped out @ {ev.price}",
            "target_fill": f"target hit @ {ev.price}",
            "flatten_fill": f"flattened @ {ev.price}",
            "cancelled": f"cancelled ({ev.reason})",
        }[ev.kind]
        log(f"#{ev.bracket_id} {detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("symbol", help="futures root, e.g. MNQ")
    ap.add_argument("--timeframe", default="5m", choices=LIVE_TIMEFRAMES)
    ap.add_argument("--account", default="Sim101")
    ap.add_argument("--armed", action="store_true", help="send real orders (default: signals only)")
    ap.add_argument("--rr", type=float, default=2.0, help="target as a multiple of risk")
    ap.add_argument("--max-trades", type=int, default=1)
    ap.add_argument("--tick-size", type=float, default=None)
    args = ap.parse_args()

    symbol = args.symbol.upper()
    tick = args.tick_size or TICK_SIZES.get(symbol)
    if tick is None:
        log(f"no tick size known for {symbol} — pass --tick-size")
        return 2

    bars: queue.Queue[dict[str, object]] = queue.Queue()
    client = FeedClient(
        subscriptions=[(symbol, args.timeframe)],
        bar_queue=bars,
        on_status=log,
        subscribe_positions=args.armed,
    )
    broker: Nt8Broker | None = None
    if args.armed:
        broker = Nt8Broker(
            transport=client,
            account=args.account,
            symbol=symbol,
            tick_size=tick,
            id_prefix=run_prefix(),
            on_status=log,
        )
        client.on_broadcast = broker.handle_broadcast

    client.start()
    try:
        if not client.wait_connected(10.0):
            log(f"could not reach {client.url} — is the MCP server running?")
            return 1
        if broker is not None:
            problem = front_month_problem(client.resolve_instrument(symbol), symbol)
            problem = problem or account_problem(
                client.sync_positions(args.account, fresh=True), args.account, symbol
            )
            if problem:
                log(f"NOT ARMING: {problem}")
                return 1
            broker.start()
            log(f"ARMED on {args.account} {symbol} {args.timeframe} — real orders will be sent")
        else:
            log(f"signals only on {symbol} {args.timeframe} — no orders (add --armed to trade)")

        bot = BreakoutBot(broker, tick=tick, rr=args.rr, max_trades=args.max_trades)
        try:
            while True:
                try:
                    msg = bars.get(timeout=1.0)
                except queue.Empty:
                    bot.handle_events()
                    continue
                bot.on_bar(msg)
        except KeyboardInterrupt:
            log("stopping")
            bot.shutdown()
        return 0
    finally:
        if broker is not None:
            broker.close()
        client.stop()


if __name__ == "__main__":
    sys.exit(main())
