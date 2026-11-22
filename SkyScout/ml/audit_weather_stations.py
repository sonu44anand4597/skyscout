"""Report BTS airport coverage from airportsdata IATA/ICAO/timezones and NOAA GHCNh stations."""
from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path

import pandas as pd

from join_historical_weather import sha256, station_index


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flights", required=True, type=Path)
    parser.add_argument("--airports", type=Path, default=Path("data/airportsdata-airports.csv"))
    parser.add_argument("--stations", type=Path, default=Path("data/ghcnh-station-list.csv"))
    parser.add_argument("--output", type=Path, default=Path("data/weather-station-coverage.json"))
    args = parser.parse_args()
    matched = station_index(args.airports, args.stations)
    counts = collections.Counter()
    for chunk in pd.read_csv(args.flights, usecols=["Origin"], chunksize=250_000):
        counts.update(chunk["Origin"].dropna().astype(str))
    covered = {iata: count for iata, count in counts.items() if iata in matched}
    missing = {iata: count for iata, count in counts.items() if iata not in matched}
    result = {
        "source": "US DOT BTS origins mapped through MIT-licensed airportsdata to NOAA NCEI GHCNh stations",
        "airport_count": len(counts),
        "matched_airports": len(covered),
        "unmatched_airports": len(missing),
        "source_rows": sum(counts.values()),
        "matched_source_rows": sum(covered.values()),
        "matched_row_fraction": sum(covered.values()) / sum(counts.values()),
        "top_origins": sorted(counts.items(), key=lambda item: item[1], reverse=True)[:30],
        "unmatched_by_volume": sorted(missing.items(), key=lambda item: item[1], reverse=True),
        "matched_stations": {iata: matched[iata] for iata in sorted(covered)},
        "sha256": {"flights": sha256(args.flights), "airports": sha256(args.airports), "stations": sha256(args.stations)},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key not in {"matched_stations", "unmatched_by_volume"}}, indent=2))
    print("Largest unmatched origins:", result["unmatched_by_volume"][:15])


if __name__ == "__main__":
    main()
