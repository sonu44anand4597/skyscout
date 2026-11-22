"""Country and carrier normalization shared by Indian training and inference."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AIRPORTS = json.loads((ROOT / "backend/data/destination-airports.json").read_text(encoding="utf-8"))
AIRPORTS.update(json.loads((ROOT / "backend/data/destination-airport-overrides.json").read_text(encoding="utf-8")))

CARRIERS = {
    "6E": "6E", "INDIGO": "6E", "INTERGLOBE AVIATION": "6E",
    "AI": "AI", "AIR INDIA": "AI", "IX": "IX", "AIR INDIA EXPRESS": "IX",
    "QP": "QP", "AKASA": "QP", "AKASA AIR": "QP",
    "SG": "SG", "SPICEJET": "SG", "9I": "9I", "ALLIANCE AIR": "9I",
}


def country(code: str) -> str | None:
    return AIRPORTS.get(str(code).upper(), {}).get("countryCode")


def region(origin: str, destination: str) -> str | None:
    left, right = country(origin), country(destination)
    return left if left == right and left in {"IN", "US"} else None


def indian_carrier(value: str) -> str | None:
    return CARRIERS.get(" ".join(str(value).upper().split()))
