"""FeedClient — a reusable /feed consumer: bars in, requests out.

One WebSocket to the MCP hub's /feed channel, on a background thread:

- subscribes the (symbol, timeframe) streams you ask for and puts every `bar`
  message on a thread-safe queue — your strategy loop only touches the queue;
- reconnects with exponential backoff and re-subscribes on every open;
- `request()` does correlated request/response (`reqId`), which is how
  orders, `sync_positions`, `resolve_instrument` and `ensure_bars` work;
- hands position/order/execution broadcasts to `on_broadcast` (see
  nt8_broker.py) when constructed with `subscribe_positions=True`.

Missed bars are NOT replayed over the socket. After a reconnect, fetch the
gap with `ensure_bars` + `get_candles`, or read the hub's SQLite cache
(README.md, "Missed bars").

Requires `websocket-client` (threaded), not `websockets` (asyncio).
"""

from __future__ import annotations

import contextlib
import json
import os
import queue
import threading
from collections.abc import Callable
from pathlib import Path
from time import sleep as _sleep
from typing import Any, cast
from uuid import uuid4

_BACKOFF_START_S = 1.0
_BACKOFF_CAP_S = 30.0
_PING_INTERVAL_S = 20
_PING_TIMEOUT_S = 10

_REPO_ROOT = Path(__file__).resolve().parents[2]


def env_value(name: str) -> str | None:
    """Process env first, then the repo's `.env.local` (the file the server
    writes the token into on first run)."""
    value = os.environ.get(name)
    if value:
        return value
    env_local = _REPO_ROOT / ".env.local"
    if not env_local.exists():
        return None
    for raw in env_local.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        if key.strip() == name:
            return val.strip().strip('"').strip("'")
    return None


def feed_url() -> str:
    """NT_FEED_URL wins; otherwise dial wherever the server binds. With NT8 in
    a VM the server binds NT_BRIDGE_HOST (e.g. 10.211.55.2) and loopback is
    refused, so the host must come from the same setting."""
    explicit = env_value("NT_FEED_URL")
    if explicit:
        return explicit
    host = env_value("NT_BRIDGE_HOST") or "127.0.0.1"
    port_raw = env_value("NT_BRIDGE_PORT")
    port = int(port_raw) if port_raw and port_raw.isdigit() else 9472
    return f"ws://{host}:{port}/feed"


def feed_token() -> str:
    token = env_value("NT_BRIDGE_TOKEN")
    if not token:
        raise RuntimeError(
            "NT_BRIDGE_TOKEN not set and not in .env.local — start the MCP server "
            "once to generate it"
        )
    return token


class _Pending:
    __slots__ = ("done", "result")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: dict[str, object] | None = None


def _require_websocket() -> Any:
    try:
        import websocket  # type: ignore[import-untyped]  # websocket-client
    except ImportError as e:
        raise ImportError(
            "feed_client needs the 'websocket-client' package: pip install websocket-client"
        ) from e
    return websocket


class FeedClient:
    """One /feed connection, N bar subscriptions, one bar queue."""

    def __init__(
        self,
        *,
        subscriptions: list[tuple[str, str]],
        bar_queue: queue.Queue[dict[str, object]],
        url: str | None = None,
        token: str | None = None,
        on_status: Callable[[str], None] | None = None,
        subscribe_positions: bool = False,
        sleeper: Callable[[float], None] = _sleep,
    ) -> None:
        if not subscriptions:
            raise ValueError("FeedClient needs at least one (symbol, timeframe) subscription")
        self._url = url or feed_url()
        self._token = token or feed_token()
        self._subs = list(subscriptions)
        self._q = bar_queue
        self._status: Callable[[str], None] = on_status or (lambda _text: None)
        self._subscribe_positions = subscribe_positions
        self._sleep = sleeper
        self._stop = threading.Event()
        self._opened = threading.Event()
        self._app: Any = None
        self._thread: threading.Thread | None = None
        self._pending: dict[str, _Pending] = {}
        self._pending_lock = threading.Lock()
        # Called on the SOCKET thread: must be fast and must never do I/O
        # (a request() from here waits on a reply this same thread delivers).
        self.on_broadcast: Callable[[dict[str, object]], None] | None = None
        self.reconnects = 0
        self.connected = False

    @property
    def url(self) -> str:
        return self._url

    # ---------- lifecycle ----------

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("FeedClient.start() called twice")
        _require_websocket()  # fail fast in the caller's thread
        self._thread = threading.Thread(target=self._run, name="feed-client", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        app = self._app
        if app is not None:
            with contextlib.suppress(Exception):  # teardown must not raise
                app.close()
        if self._thread is not None:
            self._thread.join(timeout=10.0)

    def wait_connected(self, timeout_s: float) -> bool:
        """Block until the first successful open (a startup gate)."""
        return self._opened.wait(timeout_s)

    # ---------- correlated request/response ----------

    def request(
        self, msg_type: str, payload: dict[str, object], *, timeout_s: float
    ) -> dict[str, object]:
        """Send `{type, reqId, ...payload}` and block for the matching
        `{type}_result`. Raises on a dead socket or no reply — for an order
        that means AMBIGUOUS, not "not placed"."""
        app = self._app
        if app is None or not self.connected:
            raise RuntimeError(f"{msg_type}: feed is not connected")
        req_id = uuid4().hex[:12]
        pending = _Pending()
        with self._pending_lock:
            self._pending[req_id] = pending
        try:
            app.send(json.dumps({"type": msg_type, "reqId": req_id, **payload}))
            if not pending.done.wait(timeout_s):
                raise RuntimeError(f"{msg_type}: no reply within {timeout_s:.0f}s")
        finally:
            with self._pending_lock:
                self._pending.pop(req_id, None)
        assert pending.result is not None
        return pending.result

    def sync_positions(
        self, account: str | None = None, *, fresh: bool = False, timeout_s: float = 30.0
    ) -> dict[str, object]:
        """Positions + working orders per account. fresh=True asks NT8 first
        instead of answering from the server's mirror."""
        payload: dict[str, object] = {}
        if account is not None:
            payload["account"] = account
        if fresh:
            payload["fresh"] = True
        return self.request("sync_positions", payload, timeout_s=timeout_s)

    def resolve_instrument(self, symbol: str, *, timeout_s: float = 20.0) -> dict[str, object]:
        """Which contract `symbol` binds on NT8 right now, and on whose authority."""
        return self.request("resolve_instrument", {"symbol": symbol}, timeout_s=timeout_s)

    def ensure_bars(
        self,
        symbol: str,
        timeframe: str,
        from_unix: int,
        to_unix: int,
        *,
        timeout_s: float = 300.0,
    ) -> dict[str, object]:
        """Have the server fill its cache for (from_unix, to_unix] from NT8.
        A cold range can take minutes while NT8 downloads history."""
        return self.request(
            "ensure_bars",
            {"symbol": symbol, "timeframe": timeframe, "fromUnix": from_unix, "toUnix": to_unix},
            timeout_s=timeout_s,
        )

    def _fail_pending(self, reason: str) -> None:
        with self._pending_lock:
            pendings = list(self._pending.values())
            self._pending.clear()
        for p in pendings:
            p.result = {"ok": False, "error": reason}
            p.done.set()

    # ---------- connection loop (client thread) ----------

    def _run(self) -> None:
        websocket = _require_websocket()
        backoff = _BACKOFF_START_S
        while not self._stop.is_set():
            opened_this_attempt = threading.Event()

            def on_open(ws: Any, _flag: threading.Event = opened_this_attempt) -> None:
                _flag.set()
                self.connected = True
                self._opened.set()
                self._status(f"feed connected ({self._url})")
                for symbol, timeframe in self._subs:
                    ws.send(
                        json.dumps({"type": "subscribe", "symbol": symbol, "timeframe": timeframe})
                    )
                if self._subscribe_positions:
                    ws.send(json.dumps({"type": "subscribe_positions"}))
                    if self.reconnects > 0:
                        # Broadcasts sent while we were down are never replayed:
                        # ring the same doorbell the server rings after a resync.
                        self._deliver({"type": "position_sync", "reason": "feed-reconnect"})

            def on_message(_ws: Any, raw: str | bytes) -> None:
                self._handle_message(raw)

            def on_error(_ws: Any, err: object) -> None:
                self._status(f"feed socket error: {err}")

            def on_close(_ws: Any, code: object, reason: object) -> None:
                self.connected = False
                self._fail_pending("feed disconnected before the reply arrived")
                if not self._stop.is_set():
                    self._status(f"feed disconnected (code={code} reason={reason})")

            app = websocket.WebSocketApp(
                self._url,
                header=[f"Authorization: Bearer {self._token}"],
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            self._app = app
            try:
                app.run_forever(ping_interval=_PING_INTERVAL_S, ping_timeout=_PING_TIMEOUT_S)
            except Exception as e:  # the loop owns resilience
                self._status(f"feed client crashed: {e}")
            self.connected = False
            if self._stop.is_set():
                return
            if opened_this_attempt.is_set():
                backoff = _BACKOFF_START_S
                self.reconnects += 1
            self._status(f"feed reconnecting in {backoff:.0f}s")
            self._sleep(backoff)
            backoff = min(backoff * 2, _BACKOFF_CAP_S)

    # ---------- inbound (socket thread) ----------

    def _deliver(self, msg: dict[str, object]) -> None:
        cb = self.on_broadcast
        if cb is None:
            return
        try:
            cb(msg)
        except Exception as e:  # the socket thread must survive
            self._status(f"broadcast handler failed: {e}")

    def _handle_message(self, raw: str | bytes) -> None:
        try:
            parsed: object = json.loads(raw)
        except (ValueError, TypeError):
            self._status("feed sent unparseable JSON — dropped")
            return
        if not isinstance(parsed, dict):
            return
        msg = cast(dict[str, object], parsed)
        mtype = msg.get("type")
        if mtype == "bar":
            self._q.put(msg)
        elif isinstance(mtype, str) and mtype.endswith("_result"):
            req_id = msg.get("reqId")
            with self._pending_lock:
                pending = self._pending.pop(req_id, None) if isinstance(req_id, str) else None
            if pending is not None:
                pending.result = msg
                pending.done.set()
            else:
                self._status(f"feed sent a {mtype} with no matching request")
        elif mtype in ("position_event", "position_sync", "trade_closed", "subscribed_positions"):
            self._deliver(msg)
        elif mtype == "subscribed":
            upstream = cast(dict[str, object], msg.get("upstream") or {})
            state = "live" if upstream.get("acked") else f"PENDING ({upstream.get('error')})"
            self._status(
                f"subscribed {msg.get('symbol')} {msg.get('timeframe')}: {state} "
                f"contract={upstream.get('contract')}"
            )
        elif mtype == "error":
            self._status(f"feed error: {msg.get('message')}")
        elif mtype == "welcome":
            self._status(f"feed welcome (server {msg.get('serverVersion')})")
