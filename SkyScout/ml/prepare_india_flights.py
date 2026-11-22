"""Validate genuine Indian per-flight observations and derive the existing LSTM schema.

This script never expands airline OTP percentages into flights. Its input must have
one observed flight per row, with scheduled and actual arrival timestamps.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from india_support import indian_carrier, region

REQUIRED = {
    "flight_number", "airline", "origin", "destination", "scheduled_departure",
    "scheduled_arrival", "actual_arrival", "cancelled",
}
OUTPUT = ["FlightDate", "Reporting_Airline", "Origin", "Dest", "CRSDepTime", "CRSElapsedTime", "Distance", "ArrDelay", "Cancelled"]
IST = timezone(timedelta(hours=5, minutes=30))


def observed_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Every schedule and arrival timestamp must include a timezone offset")
    return parsed


def convert_row(row: dict[str, str]) -> dict[str, object] | None:
    origin, destination = row["origin"].strip().upper(), row["destination"].strip().upper()
    if region(origin, destination) != "IN":
        raise ValueError(f"Non-Indian domestic route: {origin}-{destination}")
    carrier = indian_carrier(row["airline"])
    if not carrier or not row["flight_number"].strip().upper().startswith(carrier):
        raise ValueError("Airline and observed flight number must match a recognized Indian carrier")
    if row["cancelled"].strip().lower() in {"1", "true", "yes"}:
        return None
    if row["cancelled"].strip().lower() not in {"0", "false", "no"}:
        raise ValueError("Cancelled must be an explicit true/false value")
    departure = observed_timestamp(row["scheduled_departure"]).astimezone(IST)
    scheduled_arrival = observed_timestamp(row["scheduled_arrival"]).astimezone(IST)
    actual_arrival = observed_timestamp(row["actual_arrival"]).astimezone(IST)
    duration = (scheduled_arrival - departure).total_seconds() / 60
    delay = (actual_arrival - scheduled_arrival).total_seconds() / 60
    distance = float(row["distance_miles"]) if row.get("distance_miles") else float(row["distance_km"]) / 1.609344
    if not 20 <= duration <= 1000 or not -240 <= delay <= 1440 or not 10 <= distance <= 6000:
        raise ValueError("Flight duration, arrival delay or observed route distance is outside validation bounds")
    return {
        "FlightDate": departure.date().isoformat(), "Reporting_Airline": carrier,
        "Origin": origin, "Dest": destination,
        "CRSDepTime": departure.hour * 100 + departure.minute,
        "CRSElapsedTime": round(duration, 2), "Distance": distance,
        "ArrDelay": round(delay, 2), "Cancelled": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw_csv", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--license", required=True)
    args = parser.parse_args()
    if not args.raw_csv.is_file():
        parser.error("A genuine per-flight source CSV is required")
    if not args.source_url.startswith("https://") or not args.license.strip():
        parser.error("A HTTPS source URL and data-use license are required")
    with args.raw_csv.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        missing = REQUIRED - set(reader.fieldnames or [])
        if missing:
            parser.error("Missing observed flight fields: " + ", ".join(sorted(missing)))
        if not {"distance_miles", "distance_km"}.intersection(reader.fieldnames or []):
            parser.error("Observed route distance_miles or distance_km is required")
        rows = []
        for number, row in enumerate(reader, start=2):
            try:
                converted = convert_row(row)
            except (ValueError, KeyError) as error:
                raise SystemExit(f"Invalid observed flight at CSV line {number}: {error}") from error
            if converted is not None:
                rows.append(converted)
    if not rows:
        raise SystemExit("No eligible observed Indian flights were supplied")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=OUTPUT)
        writer.writeheader()
        writer.writerows(rows)
    provenance = {
        "record_type": "observed_individual_flights", "source_name": args.source_name,
        "source_url": args.source_url, "license": args.license,
        "raw_sha256": hashlib.sha256(args.raw_csv.read_bytes()).hexdigest(),
        "processed_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "eligible_observations": len(rows),
        "date_min": min(row["FlightDate"] for row in rows),
        "date_max": max(row["FlightDate"] for row in rows),
        "target": "actual arrival minus scheduled arrival >= 15 minutes",
        "time_zone": "Source timestamps required an explicit offset; scheduled local features use Asia/Kolkata (+05:30)",
    }
    args.output.with_suffix(args.output.suffix + ".manifest.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
