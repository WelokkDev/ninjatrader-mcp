"""Inspect a Databento DBN batch file before importing it.

Read-only. Prints metadata, the instrument_id -> raw_symbol map, and (unless
--meta-only) a per-contract per-day volume profile. Also verifies the two
conversion assumptions the importer depends on: ts_event is the interval
START in nanoseconds on an exact second boundary, and prices are int64
fixed-point at 1e-9 scale.

Usage:
    .venv-tools/Scripts/python scripts/inspect-dbn.py <file.dbn.zst> [--meta-only]
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

import databento as db

PRICE_SCALE = 1_000_000_000  # DBN fixed-point: price = raw / 1e9
NS_PER_SEC = 1_000_000_000

# Outright contracts only (MNQZ5) — spreads (MNQM6-MNQZ6) have a
# price-DIFFERENCE OHLC.
OUTRIGHT = re.compile(r"^MNQ[FGHJKMNQUVXZ]\d{1,2}$")


def build_symbology(store: db.DBNStore) -> dict[int, str]:
    """instrument_id -> raw_symbol, from the DBN metadata mappings.

    Requested with map_symbols=false, so records carry only the numeric id;
    collapsing the header's {raw_symbol: [{...,symbol}]} intervals to a flat
    dict is lossless since a futures contract keeps one id for its whole life.
    """
    out: dict[int, str] = {}
    for raw_symbol, intervals in store.metadata.mappings.items():
        for interval in intervals:
            iid = interval.get("symbol")
            if iid:
                out[int(iid)] = raw_symbol
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    meta_only = "--meta-only" in sys.argv

    store = db.DBNStore.from_file(path)
    m = store.metadata

    print("=== metadata ===")
    print(f"dataset      {m.dataset}")
    print(f"schema       {m.schema}")
    print(f"stype_in     {m.stype_in}   stype_out {m.stype_out}")
    print(f"start        {datetime.fromtimestamp(m.start / NS_PER_SEC, timezone.utc)}")
    print(f"end          {datetime.fromtimestamp(m.end / NS_PER_SEC, timezone.utc)}")
    print(f"symbols      {m.symbols}")
    print(f"mappings     {len(m.mappings)}")

    sym = build_symbology(store)
    print(f"\n=== symbology ({len(sym)} instruments) ===")
    for iid, raw in sorted(sym.items(), key=lambda kv: kv[1]):
        print(f"  {iid:>10}  {raw}")

    print("\n=== first 5 records ===")
    checked = 0
    off_second = 0
    for rec in store:
        ts = rec.ts_event
        if checked < 5:
            print(
                f"  id={rec.instrument_id:<10} {sym.get(rec.instrument_id, '?'):<10} "
                f"{datetime.fromtimestamp(ts / NS_PER_SEC, timezone.utc)}  "
                f"O={rec.open / PRICE_SCALE:.2f} H={rec.high / PRICE_SCALE:.2f} "
                f"L={rec.low / PRICE_SCALE:.2f} C={rec.close / PRICE_SCALE:.2f} V={rec.volume}"
            )
        if ts % NS_PER_SEC != 0:
            off_second += 1
        checked += 1
        if checked >= 1000:
            break
    print(f"\n  ts_event on exact second boundary: {checked - off_second}/{checked}")

    if meta_only:
        return 0

    # Per (instrument, UTC date) bar count and volume — UTC is just a bucketing
    # key; the importer rolls on session-days, not UTC days.
    print("\n=== full pass (per-contract daily volume) ===", flush=True)
    bars: dict[tuple[int, str], int] = defaultdict(int)
    vol: dict[tuple[int, str], int] = defaultdict(int)
    total = 0
    for rec in db.DBNStore.from_file(path):
        day = datetime.fromtimestamp(rec.ts_event / NS_PER_SEC, timezone.utc).strftime("%Y-%m-%d")
        key = (rec.instrument_id, day)
        bars[key] += 1
        vol[key] += rec.volume
        total += 1
        if total % 5_000_000 == 0:
            print(f"  ... {total:,} records", flush=True)

    print(f"\ntotal records: {total:,}")

    by_contract: dict[int, tuple[int, int, str, str]] = {}
    for (iid, day), n in bars.items():
        cur = by_contract.get(iid)
        if cur is None:
            by_contract[iid] = (n, vol[(iid, day)], day, day)
        else:
            by_contract[iid] = (
                cur[0] + n,
                cur[1] + vol[(iid, day)],
                min(cur[2], day),
                max(cur[3], day),
            )

    print(f"\n{'symbol':<12}{'bars':>14}{'volume':>16}  first        last")
    for iid, (n, v, first, last) in sorted(
        by_contract.items(), key=lambda kv: kv[1][0], reverse=True
    ):
        print(f"{sym.get(iid, str(iid)):<12}{n:>14,}{v:>16,}  {first}   {last}")

    # Volume-ranked front month per day (outrights only) — what the importer
    # would pick.
    print("\n=== roll profile (volume leader per UTC day, transitions only) ===")
    per_day: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for (iid, day), v in vol.items():
        if OUTRIGHT.match(sym.get(iid, "")):
            per_day[day].append((iid, v))
    prev = None
    for day in sorted(per_day):
        iid, v = max(per_day[day], key=lambda kv: kv[1])
        name = sym.get(iid, str(iid))
        if name != prev:
            print(f"  {day}  ->  {name}  ({v:,} contracts)")
            prev = name

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
