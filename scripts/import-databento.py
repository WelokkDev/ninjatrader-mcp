"""Import Databento OHLCV bars into the candle cache.

Compute half of the import; session geometry is decided in TypeScript and
handed to this script as a session-day list. Invoke via
src/scripts/import-databento.ts, not directly.

What it does:

  * decodes the .dbn.zst, keeping only OUTRIGHT contracts (calendar spreads
    like MNQM6-MNQZ6 have a price-DIFFERENCE OHLC, not a tradeable series)
  * picks a volume-ranked front month per session-day, no back-adjustment
  * converts Databento's convention to the cache's:
      timestamp = ts_event / 1e9 + 1   interval-START ns -> CLOSE-stamped seconds
      price     = raw / 1e9            int64 fixed-point
  * writes rows with source='databento', which classifySessionDay treats as
    immutable

Usage (via the TS shell):
    python scripts/import-databento.py --print-range --file F
    python scripts/import-databento.py --file F --session-days SD.json \
        --db data/candles.db --symbol MNQ --timeframe 1s [--dry-run] [--force]
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from bisect import bisect_left
from collections import defaultdict

import databento as db

PRICE_SCALE = 1_000_000_000
NS_PER_SEC = 1_000_000_000
IMPORT_SOURCE = "databento"
BATCH = 50_000

# Outright contract (e.g. MNQZ5); excludes calendar spreads (hyphenated).
OUTRIGHT = re.compile(r"^[A-Z0-9]{1,4}[FGHJKMNQUVXZ]\d{1,2}$")


def build_symbology(store: db.DBNStore) -> dict[int, str]:
    """instrument_id -> raw_symbol from the DBN header.

    Requested with map_symbols=false, so records carry only the numeric id;
    flattening the header's {raw_symbol: [{...,symbol}]} intervals is lossless
    since a futures contract keeps one id for life.
    """
    out: dict[int, str] = {}
    for raw_symbol, intervals in store.metadata.mappings.items():
        for interval in intervals:
            iid = interval.get("symbol")
            if iid:
                out[int(iid)] = raw_symbol
    return out


class SessionDays:
    """Session-day geometry handed over by the TS shell. Never derived here."""

    def __init__(self, days: list[dict]) -> None:
        days = sorted(days, key=lambda d: d["startUnix"])
        self.labels = [d["label"] for d in days]
        self.starts = [d["startUnix"] for d in days]
        self.ends = [d["endUnix"] for d in days]

    def index_of(self, stamp: int) -> int:
        """Index of the session-day holding `stamp` under (start, end], or -1
        for the maintenance break, weekends, and holidays."""
        i = bisect_left(self.ends, stamp)
        if i < len(self.ends) and self.starts[i] < stamp <= self.ends[i]:
            return i
        return -1


def print_range(path: str) -> int:
    m = db.DBNStore.from_file(path).metadata
    json.dump(
        {
            "dataset": m.dataset,
            "schema": str(m.schema),
            "startUnix": m.start // NS_PER_SEC,
            "endUnix": m.end // NS_PER_SEC,
        },
        sys.stdout,
    )
    return 0


def choose_front_months(
    path: str, sym: dict[int, str], days: SessionDays
) -> tuple[dict[int, int], int, int]:
    """Volume-ranked front month per session-day.

    Returns (day_index -> instrument_id, records_scanned, records_off_session).
    """
    vol: dict[tuple[int, int], int] = defaultdict(int)
    scanned = 0
    off_session = 0
    for rec in db.DBNStore.from_file(path):
        scanned += 1
        if not OUTRIGHT.match(sym.get(rec.instrument_id, "")):
            continue
        di = days.index_of(rec.ts_event // NS_PER_SEC + 1)
        if di < 0:
            off_session += 1
            continue
        vol[(di, rec.instrument_id)] += rec.volume
        if scanned % 5_000_000 == 0:
            print(f"  scan {scanned:,}", flush=True)

    best: dict[int, tuple[int, int]] = {}
    for (di, iid), v in vol.items():
        cur = best.get(di)
        if cur is None or v > cur[1]:
            best[di] = (iid, v)
    return {di: iid for di, (iid, _) in best.items()}, scanned, off_session


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--print-range", action="store_true")
    ap.add_argument("--session-days")
    ap.add_argument("--db")
    ap.add_argument("--symbol")
    ap.add_argument("--timeframe")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    if a.print_range:
        return print_range(a.file)

    for req in ("session_days", "db", "symbol", "timeframe"):
        if getattr(a, req) is None:
            ap.error(f"--{req.replace('_', '-')} is required unless --print-range")

    with open(a.session_days, encoding="utf-8") as fh:
        days = SessionDays(json.load(fh))
    print(f"session-days: {len(days.labels)}  {days.labels[0]} .. {days.labels[-1]}")

    store = db.DBNStore.from_file(a.file)
    sym = build_symbology(store)
    outrights = {i: s for i, s in sym.items() if OUTRIGHT.match(s)}
    print(f"instruments:  {len(sym)} total, {len(outrights)} outright")

    conn = sqlite3.connect(a.db)
    try:
        # Refuse to write over another feed's bars — INSERT OR REPLACE below
        # would silently clobber them.
        existing = conn.execute(
            "SELECT COALESCE(source,'nt8') s, COUNT(*) n FROM candles"
            " WHERE symbol = ? AND timeframe = ? GROUP BY s",
            (a.symbol, a.timeframe),
        ).fetchall()
        foreign = [(s, n) for s, n in existing if s != IMPORT_SOURCE]
        if foreign and not a.force:
            print(
                f"\nrefusing to import: {a.symbol} {a.timeframe} already holds rows from "
                f"{', '.join(f'{s} ({n:,} rows)' for s, n in foreign)}.\n"
                "Re-run with --force to overwrite them.",
                file=sys.stderr,
            )
            return 1
        for s, n in existing:
            print(f"existing:     {a.symbol} {a.timeframe} source={s} {n:,} rows")

        t0 = time.time()
        print("\npass 1/2 — volume-ranked front month per session-day", flush=True)
        front, scanned, off_session = choose_front_months(a.file, sym, days)
        print(f"  scanned {scanned:,} records in {time.time() - t0:.0f}s")
        print(f"  dropped {off_session:,} outright records outside session geometry")

        rolls = []
        prev = None
        for di in sorted(front):
            name = sym[front[di]]
            if name != prev:
                rolls.append(f"{days.labels[di]} -> {name}")
                prev = name
        print("  roll: " + " | ".join(rolls))

        if a.dry_run:
            print("\n--dry-run: no rows written")
            return 0

        print("\npass 2/2 — writing rows", flush=True)
        # Cooperative with a running MCP server (candles.db open in WAL mode):
        # NORMAL sync (OFF can corrupt a db another process is writing), a busy
        # timeout, and a commit per batch so live ingest can interleave.
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -200000")
        ins = (
            "INSERT OR REPLACE INTO candles"
            " (symbol, timeframe, timestamp, open, high, low, close, volume, source)"
            " VALUES (?,?,?,?,?,?,?,?,?)"
        )

        t1 = time.time()
        written = 0
        batch: list[tuple] = []
        for rec in db.DBNStore.from_file(a.file):
            iid = rec.instrument_id
            stamp = rec.ts_event // NS_PER_SEC + 1
            di = days.index_of(stamp)
            if di < 0 or front.get(di) != iid:
                continue
            batch.append(
                (
                    a.symbol,
                    a.timeframe,
                    stamp,
                    rec.open / PRICE_SCALE,
                    rec.high / PRICE_SCALE,
                    rec.low / PRICE_SCALE,
                    rec.close / PRICE_SCALE,
                    float(rec.volume),
                    IMPORT_SOURCE,
                )
            )
            if len(batch) >= BATCH:
                conn.executemany(ins, batch)
                conn.commit()
                written += len(batch)
                batch.clear()
                if written % (BATCH * 20) == 0:
                    print(f"  wrote {written:,}", flush=True)
        if batch:
            conn.executemany(ins, batch)
            written += len(batch)
        conn.commit()
        print(f"\nwrote {written:,} rows in {time.time() - t1:.0f}s")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
