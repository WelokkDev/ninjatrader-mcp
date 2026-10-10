"""Nt8Broker — managed bracket orders over the /feed write channel.

You hand it a Bracket (entry + stop + target); it places the entry, waits for
the FILL broadcast, then places the stop/target OCO pair priced from the
actual fill. Everything the venue does comes back as BrokerEvents you pull
with `drain()`.

Threading: one worker thread owns every `transport.request()` and all bracket
state, draining a single inbox that interleaves your commands and the socket
thread's venue broadcasts in arrival order. The socket thread only enqueues:
a request made from it would wait forever on a reply that same thread has to
deliver.

Fail-closed policy (TRADING.md, "What an ack means"):

- ok=true only means NT8 accepted the request; fills and rejections arrive
  later as order events keyed by clientOrderId.
- refused with certainlyNotSubmitted → the bracket is `cancelled`.
- ambiguous (timeout, dropped socket) → CRITICAL status, keep watching,
  never auto-retry.
- protection can't be placed, is rejected, is cancelled by someone else, or
  can't be derived from the fill → FAILSAFE flatten. An unprotected position
  is never held, and a fill price is never guessed.
- a resting entry already on the wrong side of the market is refused before
  it reaches NT8: it would fill immediately instead of resting.

Scope: one broker per (account, symbol); qty 1 (partial fills are not
handled); Day TIF, so nothing is left working overnight if the process dies.
`flatten` is instrument-wide on the account — it also cancels orders you
placed by hand on that instrument.

Order names: entry `<prefix>-<n>E`, OCO legs `<prefix>-<n>:S` / `:T`. NT8
dedupes on these names, so the prefix must be unique per run.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, Decimal
from queue import Empty, Full, Queue
from typing import Final, Literal, Protocol, cast

Direction = Literal["long", "short"]
EntryType = Literal["market", "limit", "stop", "stop_limit"]
EventKind = Literal[
    "entry_fill",
    "protection_placed",
    "stop_fill",
    "target_fill",
    "flatten_fill",
    "cancelled",
]

_REQUEST_TIMEOUT_S = 15.0
_TIF = "Day"
_INBOX_MAXSIZE = 1024
_BROADCAST_ENQUEUE_TIMEOUT_S = 1.0
_CLOSE_TIMEOUT_S = 2 * _REQUEST_TIMEOUT_S + 5.0
_WIRE_ORDER_TYPE: Final = {
    "market": "Market",
    "limit": "Limit",
    "stop": "Stop",  # NT8 StopMarket
    "stop_limit": "StopLimit",
}
_LEG_KINDS: Final[tuple[tuple[str, EventKind], ...]] = ((":S", "stop_fill"), (":T", "target_fill"))

_Phase = Literal["pending_entry", "open", "closing", "closed", "cancelled"]


class FeedTransport(Protocol):
    """The slice of FeedClient the broker uses (swap in a fake for tests)."""

    def request(
        self, msg_type: str, payload: dict[str, object], *, timeout_s: float
    ) -> dict[str, object]: ...


@dataclass(frozen=True, slots=True)
class Bracket:
    """What to trade. Prices are plain floats; the broker snaps them to the
    tick grid, always in the direction that costs you rather than flatters you.

    Target: give `target_price` (fixed level) OR `target_rr` (target =
    fill ± rr × risk, measured from the ACTUAL fill).

    Entry: `market`, or a resting `limit` / `stop` at `entry_price`, or a
    `stop_limit` triggered at `entry_price` whose limit sits
    `entry_limit_slippage_ticks` past the trigger.
    """

    direction: Direction
    stop_price: float
    target_price: float | None = None
    target_rr: float | None = None
    entry_type: EntryType = "market"
    entry_price: float | None = None
    entry_limit_slippage_ticks: int | None = None
    qty: int = 1
    tag: str = ""

    def __post_init__(self) -> None:
        if (self.target_price is None) == (self.target_rr is None):
            raise ValueError("Bracket needs exactly one of target_price / target_rr")
        if self.target_rr is not None and self.target_rr <= 0:
            raise ValueError("Bracket.target_rr must be > 0")
        if (self.entry_type == "market") != (self.entry_price is None):
            raise ValueError("entry_price is required for resting entries and invalid for market")
        if (self.entry_type == "stop_limit") != (self.entry_limit_slippage_ticks is not None):
            raise ValueError("entry_limit_slippage_ticks is required for (and only for) stop_limit")
        if self.entry_limit_slippage_ticks is not None and self.entry_limit_slippage_ticks < 0:
            raise ValueError("entry_limit_slippage_ticks must be >= 0")


@dataclass(frozen=True, slots=True)
class BrokerEvent:
    kind: EventKind
    bracket_id: int
    direction: Direction
    ts: int  # unix seconds
    price: float | None = None  # fills
    stop_price: float | None = None  # protection_placed
    target_price: float | None = None  # protection_placed
    reason: str = ""  # cancelled: why


# ---------- inbox messages ----------


@dataclass(frozen=True, slots=True)
class _Submit:
    bracket_id: int
    bracket: Bracket


@dataclass(frozen=True, slots=True)
class _Change:
    bracket_id: int
    stop_price: float | None
    target_price: float | None


@dataclass(frozen=True, slots=True)
class _Cancel:
    bracket_id: int


@dataclass(frozen=True, slots=True)
class _Flatten:
    pass


@dataclass(frozen=True, slots=True)
class _Venue:
    msg: dict[str, object]


@dataclass(frozen=True, slots=True)
class _SyncDoorbell:
    reason: str


_STOP: Final = object()


@dataclass(slots=True)
class _State:
    bracket_id: int
    bracket: Bracket
    phase: _Phase
    entry_id: str
    oco_base: str
    stop_ticks: int
    fixed_target_ticks: int | None
    entry_limit_ticks: int | None
    entry_stop_ticks: int | None
    fill_ticks: int | None = None
    target_ticks: int | None = None
    oco_attempts: int = 0


class Nt8Broker:
    def __init__(
        self,
        *,
        transport: FeedTransport,
        account: str,
        symbol: str,
        tick_size: float,
        id_prefix: str,
        on_status: Callable[[str], None] | None = None,
    ) -> None:
        if len(id_prefix) > 30:  # names are capped at 50 chars
            raise ValueError("id_prefix too long for NT8 order names")
        self._transport = transport
        self._account = account
        self._symbol = symbol
        self._tick = Decimal(str(tick_size))
        self._prefix = id_prefix
        self._status: Callable[[str], None] = on_status or (lambda _t: None)
        # Cross-thread surface: id counter, outbox, market reference.
        self._lock = threading.Lock()
        self._next_id = 1
        self._outbox: deque[BrokerEvent] = deque()
        self._market_ticks: int | None = None
        self._inbox: Queue[object] = Queue(maxsize=_INBOX_MAXSIZE)
        self._worker: threading.Thread | None = None
        self._closed = False
        # Worker-owned state below: no lock needed.
        self._brackets: dict[int, _State] = {}
        self._by_entry_id: dict[str, int] = {}
        self._by_oco_base: dict[str, int] = {}
        self._last_exec_price: float | None = None

    # ---------- lifecycle ----------

    def start(self) -> None:
        if self._closed:
            raise RuntimeError("Nt8Broker.start() after close()")
        if self._worker is not None:
            raise RuntimeError("Nt8Broker.start() called twice")
        self._worker = threading.Thread(target=self._run, name="nt8-broker", daemon=True)
        self._worker.start()

    def close(self, timeout_s: float = _CLOSE_TIMEOUT_S) -> None:
        """Process the backlog (a queued flatten must still go out), then stop."""
        if self._closed:
            return
        self._closed = True
        if self._worker is None:
            self._drain_inbox_now()
            return
        self._inbox.put(_STOP)
        self._worker.join(timeout=timeout_s)
        if self._worker.is_alive():
            self._status(
                f"CRITICAL broker worker still busy after {timeout_s:.0f}s — a request may "
                "be in flight; check positions in NT8"
            )

    def process_pending(self) -> int:
        """Run everything queued so far on the calling thread (tests only)."""
        if self._worker is not None:
            raise RuntimeError("process_pending() while the worker owns the inbox")
        return self._drain_inbox_now()

    def _drain_inbox_now(self) -> int:
        n = 0
        while True:
            try:
                msg = self._inbox.get_nowait()
            except Empty:
                return n
            if msg is not _STOP:
                self._dispatch_safe(msg)
                n += 1

    # ---------- your side: commands + events ----------

    def submit(self, bracket: Bracket) -> int:
        """Queue a bracket; returns its id. Outcomes arrive via drain()."""
        if bracket.qty != 1:
            raise ValueError("this example handles qty=1 only (partial fills are not handled)")
        with self._lock:
            bracket_id = self._next_id
            self._next_id += 1
        self._inbox.put(_Submit(bracket_id=bracket_id, bracket=bracket))
        return bracket_id

    def change(
        self, bracket_id: int, *, stop_price: float | None = None, target_price: float | None = None
    ) -> None:
        """Move the stop and/or target. Before the fill this changes the levels
        the OCO will be built with; after it, it amends the working legs."""
        self._inbox.put(
            _Change(bracket_id=bracket_id, stop_price=stop_price, target_price=target_price)
        )

    def cancel(self, bracket_id: int) -> None:
        """Cancel a still-unfilled entry. A fill can beat the cancel."""
        self._inbox.put(_Cancel(bracket_id=bracket_id))

    def flatten(self) -> None:
        """Cancel every working order on the instrument and close the position
        at market. Instrument-wide: hand-placed orders go too."""
        self._inbox.put(_Flatten())

    def drain(self, market_price: float | None = None) -> list[BrokerEvent]:
        """Events since the last call. Pass the latest bar close so resting
        entries can be checked against the market before they are sent."""
        market = None if market_price is None else self._ticks(market_price, ROUND_HALF_EVEN)
        with self._lock:
            out = list(self._outbox)
            self._outbox.clear()
            if market is not None:
                self._market_ticks = market
        return out

    # ---------- socket thread: filter + enqueue, never I/O ----------

    def handle_broadcast(self, msg: dict[str, object]) -> None:
        """Wire to FeedClient.on_broadcast."""
        mtype = msg.get("type")
        if mtype == "position_sync":
            item: object = _SyncDoorbell(reason=str(msg.get("reason") or "sync"))
        elif mtype == "position_event" and msg.get("account") == self._account:
            item = _Venue(msg=msg)
        else:
            return
        try:
            self._inbox.put(item, timeout=_BROADCAST_ENQUEUE_TIMEOUT_S)
        except Full:
            self._status("CRITICAL broker inbox full — a venue event was DROPPED; check NT8")

    # ---------- worker ----------

    def _run(self) -> None:
        while True:
            msg = self._inbox.get()
            if msg is _STOP:
                return
            self._dispatch_safe(msg)

    def _dispatch_safe(self, msg: object) -> None:
        try:
            self._dispatch(msg)
        except Exception as e:  # a handler bug must not kill the one consumer
            self._status(f"CRITICAL broker worker error on {type(msg).__name__}: {e}")

    def _dispatch(self, msg: object) -> None:
        if isinstance(msg, _Submit):
            self._do_submit(msg.bracket_id, msg.bracket)
        elif isinstance(msg, _Venue):
            self._do_venue(msg.msg)
        elif isinstance(msg, _SyncDoorbell):
            self._do_sync_doorbell(msg.reason)
        elif isinstance(msg, _Flatten):
            self._do_flatten()
        elif isinstance(msg, _Change):
            self._do_change(msg.bracket_id, msg.stop_price, msg.target_price)
        elif isinstance(msg, _Cancel):
            self._do_cancel(msg.bracket_id)

    # ---------- worker: commands ----------

    def _do_submit(self, bracket_id: int, bracket: Bracket) -> None:
        long = bracket.direction == "long"
        # Exit legs round against you (a long's stop down, its target down);
        # resting entries round away from the market (buy limit down, buy stop up).
        down_if_long = ROUND_FLOOR if long else ROUND_CEILING
        up_if_long = ROUND_CEILING if long else ROUND_FLOOR
        entry_limit_ticks: int | None = None
        entry_stop_ticks: int | None = None
        if bracket.entry_price is not None:
            if bracket.entry_type == "limit":
                entry_limit_ticks = self._ticks(bracket.entry_price, down_if_long)
            else:
                entry_stop_ticks = self._ticks(bracket.entry_price, up_if_long)
                if bracket.entry_limit_slippage_ticks is not None:
                    slip = bracket.entry_limit_slippage_ticks
                    entry_limit_ticks = entry_stop_ticks + (slip if long else -slip)
        s = _State(
            bracket_id=bracket_id,
            bracket=bracket,
            phase="pending_entry",
            entry_id=f"{self._prefix}-{bracket_id}E",
            oco_base=f"{self._prefix}-{bracket_id}",
            stop_ticks=self._ticks(bracket.stop_price, down_if_long),
            fixed_target_ticks=(
                None
                if bracket.target_price is None
                else self._ticks(bracket.target_price, down_if_long)
            ),
            entry_limit_ticks=entry_limit_ticks,
            entry_stop_ticks=entry_stop_ticks,
        )
        # Registered before the request goes out, so no broadcast about it can miss.
        self._brackets[bracket_id] = s
        self._by_entry_id[s.entry_id] = bracket_id
        self._by_oco_base[s.oco_base] = bracket_id

        with self._lock:
            market = self._market_ticks
        refusal = None if market is None else self._marketable_reason(s, market)
        if refusal is not None:
            s.phase = "cancelled"
            self._emit(s, "cancelled", reason=f"marketable_entry: {refusal}")
            self._status(f"entry {s.entry_id} REFUSED — {refusal}")
            return

        payload: dict[str, object] = {
            "account": self._account,
            "symbol": self._symbol,
            "action": "Buy" if long else "Sell",
            "orderType": _WIRE_ORDER_TYPE[bracket.entry_type],
            "quantity": bracket.qty,
            "tif": _TIF,
            "clientOrderId": s.entry_id,
            "reason": (bracket.tag or "nt8_broker example")[:120],
        }
        if entry_limit_ticks is not None:
            payload["limitPrice"] = self._price(entry_limit_ticks)
        if entry_stop_ticks is not None:
            payload["stopPrice"] = self._price(entry_stop_ticks)
        t0 = time.monotonic()
        result = self._op("place_order", payload)
        if result.get("ok"):
            ms = (time.monotonic() - t0) * 1000
            self._status(
                f"entry {s.entry_id} accepted by NT8 ({result.get('state')}) in {ms:.0f} ms"
            )
            return
        error = str(result.get("error", "unknown"))
        if result.get("certainlyNotSubmitted"):
            s.phase = "cancelled"
            self._emit(s, "cancelled", reason=f"refused: {error}")
            self._status(f"entry {s.entry_id} refused ({error}) — bracket cancelled")
            return
        self._status(
            f"CRITICAL entry {s.entry_id} ambiguous ({error}) — it MAY be live; watching its "
            "order events, not retrying. Check NT8."
        )

    def _do_change(
        self, bracket_id: int, stop_price: float | None, target_price: float | None
    ) -> None:
        s = self._brackets.get(bracket_id)
        if s is None:
            self._status(f"change: unknown bracket {bracket_id}")
            return
        rounding = ROUND_FLOOR if s.bracket.direction == "long" else ROUND_CEILING
        stop_ticks = None if stop_price is None else self._ticks(stop_price, rounding)
        target_ticks = None if target_price is None else self._ticks(target_price, rounding)
        if s.phase == "pending_entry":
            if stop_ticks is not None:
                s.stop_ticks = stop_ticks
            if target_ticks is not None:
                s.fixed_target_ticks = target_ticks
            return
        if s.phase != "open":
            self._status(f"change: bracket {bracket_id} is {s.phase}, not open — skipped")
            return
        legs = ((":S", stop_ticks, "stopPrice"), (":T", target_ticks, "limitPrice"))
        for suffix, ticks, price_field in legs:
            if ticks is None:
                continue
            result = self._op(
                "change_order",
                {
                    "account": self._account,
                    "clientOrderId": f"{s.oco_base}{suffix}",
                    price_field: self._price(ticks),
                },
            )
            if not result.get("ok"):
                # Rate-limited or refused: the leg keeps its last ACCEPTED price.
                self._status(f"change_order {s.oco_base}{suffix} failed: {result.get('error')}")
                continue
            if suffix == ":S":
                s.stop_ticks = ticks
            else:
                s.target_ticks = ticks

    def _do_cancel(self, bracket_id: int) -> None:
        s = self._brackets.get(bracket_id)
        if s is None or s.phase != "pending_entry":
            phase = "unknown" if s is None else s.phase
            self._status(f"cancel: bracket {bracket_id} is {phase}, not pending — skipped")
            return
        self._op("cancel_order", {"account": self._account, "clientOrderId": s.entry_id})
        # The outcome (Cancelled, or a fill that beat us) arrives as an order event.

    def _do_flatten(self) -> None:
        # Mark ours closing FIRST so the leg cancels it causes read as ours,
        # not as someone killing our protection.
        for s in self._brackets.values():
            if s.phase in ("pending_entry", "open"):
                s.phase = "closing"
        result = self._op("flatten", {"account": self._account, "symbol": self._symbol})
        if not result.get("ok"):
            self._status(f"CRITICAL flatten {self._symbol} failed: {result.get('error')}")

    # ---------- worker: venue broadcasts ----------

    def _do_venue(self, msg: dict[str, object]) -> None:
        kind = msg.get("kind")
        ts = msg.get("ts")
        ts_unix = ts if isinstance(ts, int) else int(time.time())
        payload = msg.get(kind) if isinstance(kind, str) else None
        if not isinstance(payload, dict):
            return
        body = cast(dict[str, object], payload)
        if body.get("symbol") != self._symbol:
            return
        if kind == "execution":
            price = body.get("price")
            if isinstance(price, int | float):
                self._last_exec_price = float(price)
        elif kind == "order":
            self._on_order_event(body, ts_unix)
        elif kind == "position":
            self._on_position_event(body, ts_unix)

    def _on_order_event(self, order: dict[str, object], ts_unix: int) -> None:
        name = order.get("name")
        state = order.get("state")
        if not isinstance(name, str) or not isinstance(state, str):
            return
        entry_bid = self._by_entry_id.get(name)
        if entry_bid is not None:
            self._on_entry_order(self._brackets[entry_bid], order, state, ts_unix)
            return
        for suffix, exit_kind in _LEG_KINDS:
            if name.endswith(suffix):
                leg_bid = self._by_oco_base.get(name[: -len(suffix)])
                if leg_bid is not None:
                    self._on_leg_order(
                        self._brackets[leg_bid], suffix, exit_kind, order, state, ts_unix
                    )
                return

    def _on_entry_order(
        self, s: _State, order: dict[str, object], state: str, ts_unix: int
    ) -> None:
        if state == "Filled":
            self._on_entry_filled_event(s, order, ts_unix)
        elif (
            state in ("Rejected", "Cancelled")
            and s.fill_ticks is None
            and s.phase in ("pending_entry", "closing")
        ):
            s.phase = "cancelled"
            self._emit(s, "cancelled", ts=ts_unix, reason=state.lower())
            self._status(f"entry {s.entry_id} {state} — bracket cancelled")

    def _on_entry_filled_event(self, s: _State, order: dict[str, object], ts_unix: int) -> None:
        if s.fill_ticks is not None:
            return  # NT8 repeats order events; the OCO is already armed
        if s.phase != "pending_entry":
            # A fill on a bracket we already retired: arming an OCO here could
            # OPEN a position later (a triggered exit on a flat account).
            self._status(
                f"CRITICAL entry {s.entry_id} Filled while the bracket is {s.phase} — "
                "FAILSAFE flatten"
            )
            self._do_flatten()
            return
        fill_price = order.get("avgFillPrice")
        if not isinstance(fill_price, int | float):
            fill_price = self._last_exec_price
        if fill_price is None:
            self._status(
                f"CRITICAL entry {s.entry_id} Filled with no fill price — FAILSAFE flatten "
                "rather than guessing protection levels"
            )
            self._do_flatten()
            return
        self._on_entry_filled(s, float(fill_price), ts_unix)

    def _on_entry_filled(self, s: _State, fill_price: float, ts_unix: int) -> None:
        # The position is real from here on — record it before any math that can raise.
        fill_ticks = self._ticks(fill_price, ROUND_HALF_EVEN)
        s.fill_ticks = fill_ticks
        fill_event_price = self._price(fill_ticks)
        try:
            stop_ticks, target_ticks = self._levels_for_fill(s, fill_ticks)
        except ValueError as e:
            self._emit(s, "entry_fill", ts=ts_unix, price=fill_event_price)
            self._status(
                f"CRITICAL no valid protection for {s.oco_base} at fill {fill_price} ({e}) — "
                "FAILSAFE flatten"
            )
            self._do_flatten()
            return
        s.stop_ticks = stop_ticks
        s.target_ticks = target_ticks

        placed = False
        while s.oco_attempts < 2 and not placed:
            s.oco_attempts += 1
            result = self._op(
                "place_oco",
                {
                    "account": self._account,
                    "symbol": self._symbol,
                    "action": "Sell" if s.bracket.direction == "long" else "Buy",
                    "quantity": s.bracket.qty,
                    "stopPrice": self._price(stop_ticks),
                    "limitPrice": self._price(target_ticks),
                    "tif": _TIF,
                    "clientOrderId": s.oco_base,
                },
            )
            placed = bool(result.get("ok"))
            if not placed and not result.get("certainlyNotSubmitted"):
                break  # ambiguous: the legs may exist — never blindly resubmit

        self._emit(s, "entry_fill", ts=ts_unix, price=fill_event_price)
        if placed:
            s.phase = "open"
            self._emit(
                s,
                "protection_placed",
                ts=ts_unix,
                stop_price=self._price(stop_ticks),
                target_price=self._price(target_ticks),
            )
            return
        self._status(f"CRITICAL protection for {s.oco_base} could not be placed — FAILSAFE flatten")
        self._do_flatten()

    def _on_leg_order(
        self,
        s: _State,
        suffix: str,
        exit_kind: EventKind,
        order: dict[str, object],
        state: str,
        ts_unix: int,
    ) -> None:
        if state == "Filled":
            if s.phase not in ("open", "closing"):
                return
            price = order.get("avgFillPrice")
            fallback = s.stop_ticks if suffix == ":S" else s.target_ticks
            s.phase = "closed"
            self._emit(
                s,
                exit_kind,
                ts=ts_unix,
                price=float(price)
                if isinstance(price, int | float)
                else (None if fallback is None else self._price(fallback)),
            )
        elif state in ("Rejected", "Cancelled") and s.phase == "open":
            # Our own flatten marks the bracket closing first, so this is
            # someone else (or NT8) removing protection. The OCO sibling dies with it.
            self._status(f"CRITICAL protection leg {s.oco_base}{suffix} {state} — FAILSAFE flatten")
            self._do_flatten()

    def _on_position_event(self, position: dict[str, object], ts_unix: int) -> None:
        if not (position.get("marketPosition") == "Flat" or position.get("quantity") == 0):
            return
        for s in self._brackets.values():
            if s.phase != "closing":
                continue
            if s.fill_ticks is None:
                s.phase = "cancelled"
                self._emit(s, "cancelled", ts=ts_unix, reason="flattened")
                continue
            s.phase = "closed"
            self._emit(s, "flatten_fill", ts=ts_unix, price=self._last_exec_price)

    # ---------- worker: reconciliation after a reconnect or resync ----------

    def _do_sync_doorbell(self, reason: str) -> None:
        """Re-read the account and reconcile: broadcasts missed while the
        socket was down are never replayed."""
        if not self._brackets:
            return
        result = self._op("sync_positions", {"account": self._account})
        if not result.get("ok"):
            self._status(f"CRITICAL position re-sync ({reason}) failed: {result.get('error')}")
            return
        if not (result.get("feedDesired") and result.get("feedUpstreamAcked")):
            self._status(
                f"CRITICAL position feed is OFF (re-sync {reason}) — fills are invisible; "
                "run subscribe_live_positions and check NT8"
            )
            return
        holding = self._holds_position(result)
        if holding is None:
            self._status(f"position re-sync ({reason}): account {self._account} not in snapshot")
            return

        for s in self._brackets.values():
            if s.phase == "closing" and s.fill_ticks is None and not holding:
                # Our flatten caught the entry before it filled; its Cancelled event was missed.
                s.phase = "cancelled"
                self._emit(s, "cancelled", reason="flattened")
                continue
            # We think we're in a trade, NT8 says flat: the exit fill was missed.
            if s.phase in ("open", "closing") and not holding:
                s.phase = "closed"
                self._emit(s, "flatten_fill", price=self._last_exec_price)
                self._status(
                    f"CRITICAL {s.oco_base} closed while unwatched (re-sync {reason}) — exit "
                    "leg unknown, recorded as flatten_fill; verify P&L in NT8"
                )
        for s in list(self._brackets.values()):
            # Entry still "working" but NT8 holds the position: it filled unseen
            # and nothing protects it.
            if s.phase == "pending_entry" and holding:
                self._status(
                    f"CRITICAL {s.entry_id} is pending but {self._account} HOLDS {self._symbol} "
                    f"(re-sync {reason}) — the entry filled unseen; FAILSAFE flatten"
                )
                self._do_flatten()
                break
        if holding and not any(s.phase in ("open", "closing") for s in self._brackets.values()):
            self._status(
                f"CRITICAL untracked {self._symbol} position on {self._account} (re-sync {reason}) "
                "— no bracket of ours explains it; check NT8"
            )

    def _holds_position(self, result: dict[str, object]) -> bool | None:
        accounts = result.get("accounts")
        if not isinstance(accounts, list):
            return None
        for raw in cast(list[object], accounts):
            if not isinstance(raw, dict):
                continue
            acct = cast(dict[str, object], raw)
            if acct.get("name") != self._account:
                continue
            positions = acct.get("positions")
            if not isinstance(positions, list):
                return False
            for p_raw in cast(list[object], positions):
                if not isinstance(p_raw, dict):
                    continue
                p = cast(dict[str, object], p_raw)
                flat = p.get("marketPosition") == "Flat" or p.get("quantity") == 0
                if p.get("symbol") == self._symbol and not flat:
                    return True
            return False
        return None

    # ---------- internals ----------

    def _levels_for_fill(self, s: _State, fill_ticks: int) -> tuple[int, int]:
        long = s.bracket.direction == "long"
        risk = fill_ticks - s.stop_ticks if long else s.stop_ticks - fill_ticks
        if risk <= 0:
            raise ValueError(f"fill is at or through the stop ({self._price(s.stop_ticks)})")
        if s.fixed_target_ticks is not None:
            return s.stop_ticks, s.fixed_target_ticks
        assert s.bracket.target_rr is not None
        reward = Decimal(str(s.bracket.target_rr)) * risk
        # Rounded toward the entry, so the reward never exceeds rr × risk.
        if long:
            target = fill_ticks + int(reward.to_integral_value(rounding=ROUND_FLOOR))
        else:
            target = fill_ticks - int(reward.to_integral_value(rounding=ROUND_FLOOR))
        return s.stop_ticks, target

    @staticmethod
    def _marketable_reason(s: _State, market_ticks: int) -> str | None:
        """A resting entry must sit strictly on its own side of the market: a
        buy limit below, a buy stop above (sells mirror). Otherwise it fills
        at once instead of resting."""
        entry_type = s.bracket.entry_type
        if entry_type == "market":
            return None
        long = s.bracket.direction == "long"
        if entry_type == "limit":
            level = s.entry_limit_ticks
            assert level is not None
            wrong = level >= market_ticks if long else level <= market_ticks
            side = "at/above" if long else "at/below"
        else:
            level = s.entry_stop_ticks  # stop and stop_limit are judged on the trigger
            assert level is not None
            wrong = level <= market_ticks if long else level >= market_ticks
            side = "at/below" if long else "at/above"
        if not wrong:
            return None
        return f"{s.bracket.direction} {entry_type} entry is {side} the last price"

    def _ticks(self, price: float, rounding: str) -> int:
        return int((Decimal(str(price)) / self._tick).to_integral_value(rounding=rounding))

    def _price(self, ticks: int) -> float:
        return float(Decimal(ticks) * self._tick)

    def _emit(
        self,
        s: _State,
        kind: EventKind,
        *,
        ts: int | None = None,
        price: float | None = None,
        stop_price: float | None = None,
        target_price: float | None = None,
        reason: str = "",
    ) -> None:
        event = BrokerEvent(
            kind=kind,
            bracket_id=s.bracket_id,
            direction=s.bracket.direction,
            ts=ts if ts is not None else int(time.time()),
            price=price,
            stop_price=stop_price,
            target_price=target_price,
            reason=reason,
        )
        with self._lock:
            self._outbox.append(event)

    def _op(self, msg_type: str, payload: dict[str, object]) -> dict[str, object]:
        try:
            return self._transport.request(msg_type, payload, timeout_s=_REQUEST_TIMEOUT_S)
        except Exception as e:  # a transport failure is an ambiguous outcome
            return {"ok": False, "error": str(e)}
