"""Minimal live-bar consumer for the ninjatrader-mcp /feed channel.

This is the seam a trading algorithm builds on: connect, subscribe, and
replace `on_bar` with your logic. Latency budget on localhost is
milliseconds — the dominant term is NT8's own tick-driven bar close
(typically tens of ms after the boundary during RTH).

Usage:
    pip install websockets
    python live_feed_client.py MNQ 5m [NQ 15m ...]

Auth: reads NT_BRIDGE_TOKEN from the environment, falling back to the
.env.local file at the repo root (the server writes it there on first run).

Wire protocol (JSON text frames):
    -> {"type": "subscribe", "symbol": "MNQ", "timeframe": "5m"}
    <- {"type": "subscribed", "ok": true, "upstream": {"acked": true, ...}}
    <- {"type": "bar", "symbol": "MNQ", "timeframe": "5m", "seq": 12,
        "candle": {"timestamp": ..., "open": ..., ...}, "backfill": false,
        "receivedAtMs": ...}

Bars marked "backfill": true closed well before delivery (catch-up after a
reconnect) — an act-on-close strategy must skip them.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import websockets

FEED_URL = os.environ.get("NT_FEED_URL", "ws://127.0.0.1:9472/feed")


def load_token() -> str:
    token = os.environ.get("NT_BRIDGE_TOKEN")
    if token:
        return token
    env_local = Path(__file__).resolve().parents[2] / ".env.local"
    if env_local.exists():
        for line in env_local.read_text().splitlines():
            if line.startswith("NT_BRIDGE_TOKEN="):
                return line.split("=", 1)[1].strip()
    raise SystemExit(
        "NT_BRIDGE_TOKEN not set and .env.local not found — start the MCP "
        "server once to generate the token."
    )


def parse_streams(argv: list[str]) -> list[tuple[str, str]]:
    if len(argv) < 2 or len(argv) % 2 != 1:
        raise SystemExit(f"usage: {argv[0]} SYMBOL TF [SYMBOL TF ...]   (TF: 15s|5m|15m)")
    pairs = list(zip(argv[1::2], argv[2::2]))
    return [(sym.upper(), tf) for sym, tf in pairs]


def on_bar(msg: dict) -> None:
    """Replace this with your algorithm's bar handler."""
    candle = msg["candle"]
    now_ms = time.time() * 1000
    wire_ms = now_ms - msg["receivedAtMs"]          # server -> here
    close_lag_s = now_ms / 1000 - candle["timestamp"]  # bar boundary -> here
    tag = " BACKFILL" if msg.get("backfill") else ""
    print(
        f"{msg['symbol']} {msg['timeframe']} seq={msg.get('seq', '?')} "
        f"close={candle['close']} vol={candle['volume']} "
        f"lag={close_lag_s:.2f}s wire={wire_ms:.0f}ms{tag}"
    )


async def run(streams: list[tuple[str, str]]) -> None:
    token = load_token()
    headers = {"Authorization": f"Bearer {token}"}
    delay = 1
    while True:
        try:
            async with websockets.connect(
                FEED_URL, additional_headers=headers, ping_interval=20
            ) as ws:
                print(f"connected to {FEED_URL}")
                delay = 1  # successful connect resets the backoff
                for symbol, tf in streams:
                    await ws.send(
                        json.dumps({"type": "subscribe", "symbol": symbol, "timeframe": tf})
                    )
                async for frame in ws:
                    msg = json.loads(frame)
                    kind = msg.get("type")
                    if kind == "bar":
                        on_bar(msg)
                    elif kind == "subscribed":
                        up = msg.get("upstream") or {}
                        state = "LIVE" if up.get("acked") else f"PENDING ({up.get('error')})"
                        print(f"subscribed {msg['symbol']} {msg['timeframe']}: {state}")
                    elif kind == "welcome":
                        subs = msg.get("subscriptions") or []
                        print(f"server hello — {len(subs)} active subscription(s)")
                    elif kind == "error":
                        print(f"server error: {msg.get('message')}")
        except (OSError, websockets.WebSocketException) as exc:
            print(f"feed connection lost ({exc}); retrying in {delay}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


def main() -> None:
    streams = parse_streams(sys.argv)
    try:
        asyncio.run(run(streams))
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
