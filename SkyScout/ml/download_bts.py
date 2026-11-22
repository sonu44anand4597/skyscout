"""Download and combine official BTS monthly on-time performance archives."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import pandas as pd

from train import REQUIRED

BTS_ARCHIVE = (
    "https://transtats.bts.gov/PREZIP/"
    "On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{year}_{month}.zip"
)
MONTH_PATTERN = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def parse_month(value: str) -> tuple[int, int]:
    match = MONTH_PATTERN.fullmatch(value)
    if not match:
        raise argparse.ArgumentTypeError("Use YYYY-MM for each month.")
    return int(match.group(1)), int(match.group(2))


def months_between(start: tuple[int, int], end: tuple[int, int]) -> list[tuple[int, int]]:
    first = start[0] * 12 + start[1] - 1
    last = end[0] * 12 + end[1] - 1
    if last < first:
        raise ValueError("End month must be on or after start month.")
    if last - first > 59:
        raise ValueError("Download ranges are limited to five years at a time.")
    return [(index // 12, index % 12 + 1) for index in range(first, last + 1)]


def valid_archive(path: Path) -> bool:
    try:
        with ZipFile(path) as archive:
            return archive.testzip() is None and len(
                [name for name in archive.namelist() if name.lower().endswith(".csv")]
            ) == 1
    except (BadZipFile, OSError):
        return False


def download_archive(year: int, month: int, destination: Path, timeout: int) -> None:
    if destination.exists() and valid_archive(destination):
        return
    if destination.exists():
        destination.unlink()

    url = BTS_ARCHIVE.format(year=year, month=month)
    temporary = destination.with_suffix(destination.suffix + ".part")
    if valid_archive(temporary):
        temporary.replace(destination)
        return
    offset = temporary.stat().st_size if temporary.exists() else 0
    headers = {
        "User-Agent": "SkyScout BTS training-data downloader/1.0",
        "Accept-Encoding": "identity",
    }
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, temporary.open(
            "ab" if offset and response.status == 206 else "wb"
        ) as output:
            range_match = None
            if offset and response.status == 206:
                content_range = response.headers.get("Content-Range", "")
                range_match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+|\*)", content_range)
                if not range_match or int(range_match.group(1)) != offset:
                    raise ValueError("BTS server returned an invalid byte range for the partial archive.")
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
            output.flush()
            if range_match and range_match.group(3) != "*" and temporary.stat().st_size != int(range_match.group(3)):
                raise TimeoutError("Resumed BTS archive is incomplete; run the downloader again to continue.")
        if not valid_archive(temporary):
            temporary.unlink(missing_ok=True)
            raise ValueError("BTS response is not a complete archive with exactly one CSV member.")
        temporary.replace(destination)
    except urllib.error.HTTPError as error:
        if error.code == 416 and offset:
            temporary.unlink(missing_ok=True)
            download_archive(year, month, destination, timeout)
            return
        raise
    except (urllib.error.URLError, TimeoutError, http.client.IncompleteRead) as error:
        if temporary.exists():
            raise TimeoutError(f"{error}. Partial bytes were saved; run the downloader again to resume.") from error
        raise
    except (OSError, BadZipFile, ValueError):
        temporary.unlink(missing_ok=True)
        raise


def download_with_retries(year: int, month: int, destination: Path, timeout: int, retries: int, sleep=time.sleep) -> None:
    for attempt in range(retries + 1):
        try:
            download_archive(year, month, destination, timeout)
            return
        except TimeoutError:
            if attempt >= retries:
                raise
            delay = min(2 ** attempt, 30)
            print(f"Transfer paused; retrying {year}-{month:02d} in {delay}s from the saved byte offset...", flush=True)
            sleep(delay)


def combine_archives(archives: list[Path], output_path: Path, chunk_size: int) -> dict:
    temporary_output = output_path.with_suffix(output_path.suffix + ".part")
    temporary_output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output.unlink(missing_ok=True)
    records = 0
    digest = hashlib.sha256()
    try:
        for archive_path in archives:
            with ZipFile(archive_path) as archive:
                csv_member = next(name for name in archive.namelist() if name.lower().endswith(".csv"))
                with archive.open(csv_member) as source:
                    first_chunk = True
                    for frame in pd.read_csv(source, usecols=lambda name: name in REQUIRED, chunksize=chunk_size, low_memory=False):
                        missing = sorted(set(REQUIRED) - set(frame.columns))
                        if missing:
                            raise ValueError(f"{archive_path.name} is missing BTS columns: {', '.join(missing)}")
                        frame.to_csv(temporary_output, mode="w" if first_chunk and records == 0 else "a", index=False, header=first_chunk and records == 0)
                        first_chunk = False
                        records += len(frame)
        if records == 0:
            raise ValueError("No BTS rows were downloaded; refusing to create an empty training dataset.")
        with temporary_output.open("rb") as combined:
            for chunk in iter(lambda: combined.read(1024 * 1024), b""):
                digest.update(chunk)
        temporary_output.replace(output_path)
    except Exception:
        temporary_output.unlink(missing_ok=True)
        raise
    return {
        "source": "US DOT BTS Reporting Carrier On-Time Performance",
        "source_archive_pattern": BTS_ARCHIVE,
        "output": str(output_path),
        "records": records,
        "sha256": digest.hexdigest(),
        "months": [path.stem.replace("BTS_", "") for path in archives],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=parse_month, required=True, help="First BTS month, YYYY-MM")
    parser.add_argument("--end", type=parse_month, required=True, help="Last BTS month, YYYY-MM")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "data" / "bts-on-time.csv")
    parser.add_argument("--cache-dir", type=Path, default=Path(__file__).parent / "data")
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--retries", type=int, default=5, help="Resume a timed-out monthly transfer this many times")
    parser.add_argument("--chunk-size", type=int, default=100_000)
    args = parser.parse_args()
    if args.timeout < 1 or args.chunk_size < 1 or args.retries < 0:
        parser.error("--timeout and --chunk-size must be positive; --retries cannot be negative")
    try:
        months = months_between(args.start, args.end)
        current_month = (date.today().year, date.today().month)
        if months[-1] >= current_month:
            parser.error("Select completed months only; the current month may be incomplete.")
        args.cache_dir.mkdir(parents=True, exist_ok=True)
        archives = []
        for year, month in months:
            path = args.cache_dir / f"BTS_{year}_{month:02d}.zip"
            print(f"Fetching/validating {year}-{month:02d}...", flush=True)
            download_with_retries(year, month, path, args.timeout, args.retries)
            archives.append(path)
        manifest = combine_archives(archives, args.output, args.chunk_size)
        manifest_path = args.output.with_suffix(args.output.suffix + ".manifest.json")
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(json.dumps(manifest, indent=2))
        print(f"Manifest: {manifest_path}")
        return 0
    except (ValueError, urllib.error.URLError, TimeoutError, OSError, BadZipFile, pd.errors.ParserError) as error:
        print(f"BTS download failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
