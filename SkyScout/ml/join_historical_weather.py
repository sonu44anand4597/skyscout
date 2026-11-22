"""Pilot a leakage-safe BTS departure / NOAA GHCNh observation join for one airport-year."""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import math
from pathlib import Path

import pandas as pd


WEATHER_FIELDS = ["temperature", "wind_speed", "visibility", "ceiling_height", "precipitation"]
WEATHER_UNITS = {
    "temperature": "degrees Celsius",
    "wind_speed": "meters per second",
    "visibility": "kilometers",
    "ceiling_height": "meters above ground level",
    "precipitation": "millimeters, nominally per hour",
}
MAX_WEATHER_AGE_MINUTES = 120
US_AND_TERRITORIES = {"US", "GU", "MP", "AS", "PR", "VI"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    lat1, lat2 = math.radians(a_lat), math.radians(b_lat)
    delta_lat = lat2 - lat1
    delta_lon = math.radians(b_lon - a_lon)
    inner = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(inner))


def station_index(airports_path: Path, stations_path: Path) -> dict[str, dict]:
    with airports_path.open(encoding="utf-8", newline="") as source:
        airports = {row["iata"]: row for row in csv.DictReader(source) if row["iata"] and row["country"] in US_AND_TERRITORIES and row["tz"]}
    by_icao = collections.defaultdict(list)
    by_country = collections.defaultdict(list)
    with stations_path.open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            if not row["GHCN_ID"] or not row["LATITUDE"] or not row["LONGITUDE"]:
                continue
            if row["ICAO"]:
                by_icao[row["ICAO"]].append(row)
            if row["ISO_CODE"] in US_AND_TERRITORIES:
                by_country[row["ISO_CODE"]].append(row)
    matched = {}
    for iata, airport in airports.items():
        candidates = by_icao.get(airport["icao"], [])
        match_method = "exact_icao"
        max_distance = 25
        if not candidates:
            candidates = by_country.get(airport["country"], [])
            match_method = "nearby_station"
            max_distance = 5
        if not candidates:
            continue
        distance, station = min(((haversine_km(float(airport["lat"]), float(airport["lon"]), float(row["LATITUDE"]), float(row["LONGITUDE"])), row) for row in candidates), key=lambda item: item[0])
        if distance <= max_distance:
            matched[iata] = {"iata": iata, "icao": airport["icao"], "timezone": airport["tz"], "ghcn_id": station["GHCN_ID"], "station_icao": station["ICAO"] or None, "station_name": station["NAME"], "station_distance_km": round(distance, 2), "match_method": match_method}
    return matched


def resolve_station(iata: str, airports_path: Path, stations_path: Path) -> dict:
    station = station_index(airports_path, stations_path).get(iata)
    if not station:
        raise ValueError(f"No safely matched NOAA GHCNh station and timezone were found for {iata}.")
    return station


def read_weather(path: Path, station_id: str, year: int) -> pd.DataFrame:
    columns = ["STATION", "DATE", *WEATHER_FIELDS]
    weather = pd.read_csv(path, sep="|", usecols=columns, low_memory=False)
    weather = weather.loc[weather["STATION"].eq(station_id), ["DATE", *WEATHER_FIELDS]].copy()
    weather["observedAtUtc"] = pd.to_datetime(weather.pop("DATE"), utc=True, errors="coerce")
    weather = weather.loc[weather["observedAtUtc"].dt.year.eq(year)]
    bounds = {"temperature": (-80, 60), "wind_speed": (0, 100), "visibility": (0, 100), "ceiling_height": (0, 30000), "precipitation": (0, 1000)}
    for field, (low, high) in bounds.items():
        weather[field] = pd.to_numeric(weather[field], errors="coerce").where(lambda values: values.between(low, high))
    weather["present_fields"] = weather[WEATHER_FIELDS].notna().sum(axis=1)
    return (weather.loc[weather["present_fields"].gt(0)]
            .sort_values(["observedAtUtc", "present_fields"])
            .drop_duplicates("observedAtUtc", keep="last")
            .drop(columns="present_fields")
            .reset_index(drop=True))


def read_departures(path: Path, iata: str, year: int, timezone: str) -> tuple[pd.DataFrame, int]:
    kept = []
    invalid_schedule = 0
    columns = ["FlightDate", "Reporting_Airline", "Origin", "Dest", "CRSDepTime", "ArrDelay", "Cancelled", "CRSElapsedTime", "Distance"]
    for chunk in pd.read_csv(path, usecols=columns, chunksize=100_000, low_memory=False):
        chunk = chunk.loc[chunk["Origin"].eq(iata) & chunk["FlightDate"].str.startswith(str(year)) & chunk["Cancelled"].eq(0) & chunk["ArrDelay"].notna()].copy()
        if chunk.empty:
            continue
        scheduled = pd.to_numeric(chunk["CRSDepTime"], errors="coerce")
        hours = scheduled // 100
        minutes = scheduled % 100
        valid = scheduled.notna() & minutes.between(0, 59) & ((hours.between(0, 23)) | ((hours.eq(24)) & minutes.eq(0)))
        invalid_schedule += int((~valid).sum())
        chunk = chunk.loc[valid].copy()
        departure_local = pd.to_datetime(chunk["FlightDate"], errors="coerce") + pd.to_timedelta((hours.loc[valid] * 60 + minutes.loc[valid]), unit="m")
        departure_utc = departure_local.dt.tz_localize(timezone, ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")
        invalid_schedule += int(departure_utc.isna().sum())
        chunk["departureAtUtc"] = departure_utc
        chunk = chunk.loc[chunk["departureAtUtc"].notna()]
        chunk["significantDelay"] = chunk["ArrDelay"].ge(15).astype("int8")
        kept.append(chunk[["FlightDate", "Reporting_Airline", "Origin", "Dest", "CRSDepTime", "departureAtUtc", "significantDelay", "CRSElapsedTime", "Distance"]])
    if not kept:
        raise ValueError(f"No eligible {iata} departures were found in {year}.")
    return pd.concat(kept, ignore_index=True).sort_values("departureAtUtc").reset_index(drop=True), invalid_schedule


def join_departures(departures: pd.DataFrame, weather: pd.DataFrame) -> pd.DataFrame:
    joined = pd.merge_asof(departures, weather, left_on="departureAtUtc", right_on="observedAtUtc", direction="backward", tolerance=pd.Timedelta(minutes=MAX_WEATHER_AGE_MINUTES))
    joined["weatherAgeMinutes"] = (joined["departureAtUtc"] - joined["observedAtUtc"]).dt.total_seconds() / 60
    if joined["weatherAgeMinutes"].dropna().lt(0).any():
        raise AssertionError("A weather observation after scheduled departure entered the training join.")
    return joined


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iata", required=True, type=str.upper)
    parser.add_argument("--year", required=True, type=int)
    parser.add_argument("--flights", required=True, type=Path)
    parser.add_argument("--weather", required=True, type=Path)
    parser.add_argument("--airports", type=Path, default=Path("data/airportsdata-airports.csv"))
    parser.add_argument("--stations", type=Path, default=Path("data/ghcnh-station-list.csv"))
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not len(args.iata) == 3 or not args.iata.isalpha() or args.year < 1987:
        parser.error("Use a three-letter IATA code and a BTS-supported year.")
    station = resolve_station(args.iata, args.airports, args.stations)
    weather = read_weather(args.weather, station["ghcn_id"], args.year)
    departures, invalid_schedule = read_departures(args.flights, args.iata, args.year, station["timezone"])
    joined = join_departures(departures, weather)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    joined.to_csv(args.output, index=False)
    report = {
        "source": "NOAA NCEI GHCNh hourly observations joined to US DOT BTS scheduled departures",
        "station": station,
        "year": args.year,
        "max_weather_age_minutes": MAX_WEATHER_AGE_MINUTES,
        "flights": len(departures),
        "invalid_or_ambiguous_local_schedules_excluded": invalid_schedule,
        "weather_observations": len(weather),
        "joined_with_recent_observation": int(joined["observedAtUtc"].notna().sum()),
        "complete_numeric_weather": int(joined[WEATHER_FIELDS].notna().all(axis=1).sum()),
        "field_coverage": {field: float(joined[field].notna().mean()) for field in WEATHER_FIELDS},
        "weather_units": WEATHER_UNITS,
        "weather_units_source": "https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/doc/ghcnh_DOCUMENTATION.pdf",
        "sha256": {name: sha256(path) for name, path in {"flights": args.flights, "weather": args.weather, "airports": args.airports, "stations": args.stations, "output": args.output}.items()},
    }
    manifest = args.output.with_suffix(args.output.suffix + ".manifest.json")
    manifest.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
