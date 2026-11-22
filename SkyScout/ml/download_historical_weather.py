"""Download NOAA GHCNh airport-year files into compact, verified observation partitions."""
from __future__ import annotations

import argparse
import json
import re
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

from join_historical_weather import WEATHER_UNITS, read_weather, sha256


SOURCE_URL = "https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-year/{year}/psv/GHCNh_{station}_{year}.psv"


def download_psv(url: str, destination: Path, timeout: int) -> None:
    if destination.exists():
        with destination.open("rb") as source:
            header = source.readline()
        if all(field in header for field in [b"STATION|", b"DATE|", b"wind_speed|"]):
            return
        destination.unlink()
    partial = destination.with_suffix(destination.suffix + ".part")
    offset = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "SkyScout historical weather research downloader/1.0", "Accept-Encoding": "identity"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            mode = "ab" if offset and response.status == 206 else "wb"
            expected = None
            if response.status == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not match or int(match.group(1)) != offset:
                    raise ValueError("NOAA returned an unexpected range for a partial file.")
                expected = int(match.group(3))
            elif response.headers.get("Content-Length"):
                expected = int(response.headers["Content-Length"])
            with partial.open(mode) as output:
                while block := response.read(1024 * 1024):
                    output.write(block)
            if expected is not None and partial.stat().st_size != expected:
                raise TimeoutError("The NOAA station-year response was incomplete.")
        with partial.open("rb") as source:
            header = source.readline()
        if not all(field in header for field in [b"STATION|", b"DATE|", b"wind_speed|"]):
            raise ValueError("The NOAA response does not contain the expected GHCNh PSV fields.")
        partial.replace(destination)
    except urllib.error.HTTPError as error:
        if error.code == 416 and offset:
            partial.unlink(missing_ok=True)
            download_psv(url, destination, timeout)
            return
        raise


def compact_station_year(station: str, year: int, raw_path: Path, output_path: Path, source_url: str) -> dict:
    weather = read_weather(raw_path, station, year)
    if weather.empty:
        raise ValueError(f"NOAA file {station} / {year} contains no valid observations.")
    raw_digest = sha256(raw_path)
    temporary = output_path.with_suffix(output_path.suffix + ".part")
    weather.to_csv(temporary, index=False, compression="gzip")
    temporary.replace(output_path)
    report = {
        "source": "NOAA NCEI Global Historical Climatology Network hourly (GHCNh)",
        "source_url": source_url,
        "station": station,
        "year": year,
        "observations": len(weather),
        "first_observation_utc": weather["observedAtUtc"].min().isoformat(),
        "last_observation_utc": weather["observedAtUtc"].max().isoformat(),
        "units": WEATHER_UNITS,
        "units_source": "https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/doc/ghcnh_DOCUMENTATION.pdf",
        "raw_sha256": raw_digest,
        "compact_sha256": sha256(output_path),
    }
    output_path.with_suffix(output_path.suffix + ".manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coverage", type=Path, default=Path("data/weather-station-coverage.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/weather"))
    parser.add_argument("--iata", help="Comma-separated airport sample; omit for all mapped airports")
    parser.add_argument("--start-year", type=int, default=2023)
    parser.add_argument("--end-year", type=int, default=2025)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--retries", type=int, default=5)
    args = parser.parse_args()
    if args.start_year > args.end_year or args.timeout < 1 or args.retries < 0:
        parser.error("Choose an ordered year range, a positive timeout and nonnegative retries.")
    coverage = json.loads(args.coverage.read_text(encoding="utf-8"))
    stations = coverage["matched_stations"]
    selected = [item.strip().upper() for item in args.iata.split(",")] if args.iata else list(stations)
    unknown = sorted(set(selected) - set(stations))
    if unknown:
        parser.error(f"Airports have no audited station mapping: {', '.join(unknown)}")
    station_ids = sorted({stations[iata]["ghcn_id"] for iata in selected})
    completed = 0
    missing = []
    for year in range(args.start_year, args.end_year + 1):
        year_dir = args.output_dir / str(year)
        year_dir.mkdir(parents=True, exist_ok=True)
        for station in station_ids:
            compact_path = year_dir / f"{station}.csv.gz"
            manifest_path = compact_path.with_suffix(compact_path.suffix + ".manifest.json")
            if compact_path.exists() and manifest_path.exists():
                previous = json.loads(manifest_path.read_text(encoding="utf-8"))
                if previous.get("compact_sha256") == sha256(compact_path):
                    completed += 1
                    continue
            source_url = SOURCE_URL.format(station=station, year=year)
            raw_path = year_dir / f"GHCNh_{station}_{year}.psv"
            for attempt in range(args.retries + 1):
                try:
                    download_psv(source_url, raw_path, args.timeout)
                    report = compact_station_year(station, year, raw_path, compact_path, source_url)
                    raw_path.unlink(missing_ok=True)
                    completed += 1
                    print(f"{year} {station}: {report['observations']} observations", flush=True)
                    break
                except urllib.error.HTTPError as error:
                    if error.code == 404:
                        missing.append({"year": year, "station": station, "status": 404})
                        print(f"{year} {station}: unavailable (404)", flush=True)
                        break
                    if attempt >= args.retries:
                        raise
                except (TimeoutError, socket.timeout, urllib.error.URLError):
                    if attempt >= args.retries:
                        raise
                time.sleep(min(2 ** attempt, 30))
    summary = {"station_years_completed": completed, "station_years_missing": missing, "station_count": len(station_ids), "years": [args.start_year, args.end_year], "coverage_manifest_sha256": sha256(args.coverage)}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "download-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
