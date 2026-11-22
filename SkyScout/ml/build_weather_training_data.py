"""Join selected BTS origins to preceding NOAA observations in one source pass.

This prepares an experimental dataset. It does not change the production model.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from join_historical_weather import MAX_WEATHER_AGE_MINUTES, WEATHER_FIELDS, WEATHER_UNITS, sha256


FLIGHT_COLUMNS = [
    "FlightDate", "Reporting_Airline", "Origin", "Dest", "CRSDepTime",
    "CRSElapsedTime", "Distance", "ArrDelay", "Cancelled",
]
WEATHER_PREDICTION_LEAD_MINUTES = 45


def scheduled_utc(rows: pd.DataFrame, timezone: str) -> pd.Series:
    time = pd.to_numeric(rows["CRSDepTime"], errors="coerce")
    hours = time // 100
    minutes = time % 100
    valid = time.notna() & minutes.between(0, 59) & (
        hours.between(0, 23) | (hours.eq(24) & minutes.eq(0))
    )
    local = pd.to_datetime(rows["FlightDate"], errors="coerce") + pd.to_timedelta(
        (hours.where(valid) * 60 + minutes.where(valid)), unit="m"
    )
    return local.dt.tz_localize(timezone, ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")


def load_station_weather(station_id: str, years: list[int], root: Path) -> pd.DataFrame:
    parts = []
    for year in years:
        path = root / str(year) / f"{station_id}.csv.gz"
        manifest = path.with_suffix(path.suffix + ".manifest.json")
        if not path.is_file() or not manifest.is_file():
            raise FileNotFoundError(f"A verified weather partition is missing: {path}")
        record = json.loads(manifest.read_text(encoding="utf-8"))
        if record.get("compact_sha256") != sha256(path):
            raise ValueError(f"Weather partition digest mismatch: {path}")
        part = pd.read_csv(path, usecols=["observedAtUtc", *WEATHER_FIELDS], low_memory=False)
        part["observedAtUtc"] = pd.to_datetime(part["observedAtUtc"], utc=True)
        parts.append(part)
    return pd.concat(parts, ignore_index=True).sort_values("observedAtUtc").drop_duplicates("observedAtUtc", keep="last")


def join_chunk(rows: pd.DataFrame, stations: dict, weather_by_station: dict) -> pd.DataFrame:
    groups = []
    for origin, group in rows.groupby("Origin", sort=False):
        station = stations[origin]
        group = group.copy()
        group["departureAtUtc"] = scheduled_utc(group, station["timezone"])
        group = group[group["departureAtUtc"].notna()].sort_values("departureAtUtc")
        if group.empty:
            continue
        group["weatherCutoffUtc"] = group["departureAtUtc"] - pd.Timedelta(minutes=WEATHER_PREDICTION_LEAD_MINUTES)
        weather = weather_by_station[station["ghcn_id"]]
        joined = pd.merge_asof(
            group, weather, left_on="weatherCutoffUtc", right_on="observedAtUtc",
            direction="backward", tolerance=pd.Timedelta(minutes=MAX_WEATHER_AGE_MINUTES - WEATHER_PREDICTION_LEAD_MINUTES),
        )
        joined["weatherAgeMinutes"] = (
            joined["departureAtUtc"] - joined["observedAtUtc"]
        ).dt.total_seconds() / 60
        if joined["weatherAgeMinutes"].dropna().lt(WEATHER_PREDICTION_LEAD_MINUTES).any():
            raise AssertionError("An observation after the prediction cutoff entered the training dataset.")
        groups.append(joined)
    return pd.concat(groups, ignore_index=True) if groups else pd.DataFrame()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("flights", type=Path)
    parser.add_argument("--coverage", type=Path, default=Path("data/weather-station-coverage.json"))
    parser.add_argument("--weather-dir", type=Path, default=Path("data/weather"))
    parser.add_argument("--output", type=Path, default=Path("data/bts-weather-top20-2023-2025.csv"))
    parser.add_argument("--iata", help="Comma-separated origins; default is the twenty busiest in the coverage audit")
    parser.add_argument("--years", default="2023,2024,2025")
    parser.add_argument("--chunksize", type=int, default=100_000)
    args = parser.parse_args()
    if args.chunksize < 1000:
        parser.error("chunksize must be at least 1000")
    years = sorted({int(value) for value in args.years.split(",")})
    coverage = json.loads(args.coverage.read_text(encoding="utf-8"))
    selected = [value.strip().upper() for value in args.iata.split(",")] if args.iata else [item[0] for item in coverage["top_origins"][:20]]
    missing = set(selected) - set(coverage["matched_stations"])
    if missing:
        parser.error("No audited station for: " + ", ".join(sorted(missing)))
    stations = {iata: coverage["matched_stations"][iata] for iata in selected}
    weather_by_station = {
        station_id: load_station_weather(station_id, years, args.weather_dir)
        for station_id in sorted({value["ghcn_id"] for value in stations.values()})
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".part")
    counts = {"source_rows": 0, "selected_eligible_rows": 0, "valid_schedule_rows": 0, "recent_weather_rows": 0}
    coverage_counts = {field: 0 for field in WEATHER_FIELDS}
    wrote_header = False
    try:
        for chunk in pd.read_csv(args.flights, usecols=FLIGHT_COLUMNS, chunksize=args.chunksize, low_memory=False):
            counts["source_rows"] += len(chunk)
            chunk = chunk.loc[
                chunk["Origin"].isin(selected)
                & pd.to_datetime(chunk["FlightDate"], errors="coerce").dt.year.isin(years)
                & chunk["Cancelled"].eq(0)
                & chunk["ArrDelay"].notna()
                & chunk["CRSElapsedTime"].gt(0)
                & chunk["Distance"].gt(0)
            ].copy()
            counts["selected_eligible_rows"] += len(chunk)
            if chunk.empty:
                continue
            joined = join_chunk(chunk, stations, weather_by_station)
            if joined.empty:
                continue
            counts["valid_schedule_rows"] += len(joined)
            counts["recent_weather_rows"] += int(joined["observedAtUtc"].notna().sum())
            for field in WEATHER_FIELDS:
                coverage_counts[field] += int(joined[field].notna().sum())
            joined.to_csv(temporary, mode="a", header=not wrote_header, index=False)
            wrote_header = True
            if counts["source_rows"] % 1_000_000 < args.chunksize:
                print(f"Read {counts['source_rows']:,} BTS rows; joined {counts['valid_schedule_rows']:,}", flush=True)
        if not wrote_header:
            raise ValueError("No eligible flights were joined.")
        temporary.replace(args.output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    manifest = {
        "source": "US DOT BTS departures joined to preceding NOAA NCEI GHCNh observations",
        "origins": selected,
        "years": years,
        "weather_age_limit_minutes": MAX_WEATHER_AGE_MINUTES,
        "prediction_lead_minutes": WEATHER_PREDICTION_LEAD_MINUTES,
        "weather_units": WEATHER_UNITS,
        "counts": counts,
        "weather_field_coverage": {
            field: coverage_counts[field] / counts["valid_schedule_rows"]
            for field in WEATHER_FIELDS
        },
        "sha256": {
            "flights": sha256(args.flights),
            "coverage": sha256(args.coverage),
            "output": sha256(args.output),
        },
    }
    args.output.with_suffix(args.output.suffix + ".manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
