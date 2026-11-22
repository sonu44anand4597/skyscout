"""Rebuild the bundled MIT airport search snapshot; no network or dependencies."""
import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
source = ROOT / "ml/data/airportsdata-airports.csv"
overrides = json.loads((ROOT / "backend/data/airport-search-overrides.json").read_text(encoding="utf-8"))
airports = {}
with source.open(encoding="utf-8-sig", newline="") as handle:
    for row in csv.DictReader(handle):
        code = row["iata"].strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", code) or not row["name"].strip() or not re.fullmatch(r"[A-Z]{2}", row["country"]):
            continue
        extra = overrides.get(code, {})
        airports[code] = {
            "iata": code, "name": extra.get("name", row["name"].strip()),
            "city": extra.get("city", row["city"].strip() or row["name"].strip()),
            "countryCode": row["country"], "timezone": row["tz"],
            "aliases": list(dict.fromkeys([row["city"], row["name"], *extra.get("aliases", [])])),
        }
payload = {
    "source": "https://github.com/mborsetti/airportsdata", "license": "MIT; see THIRD_PARTY_NOTICES.md",
    "inputSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "derivedAt": datetime.now(timezone.utc).isoformat(),
    "airports": sorted(airports.values(), key=lambda airport: airport["iata"]),
}
target = ROOT / "backend/data/airport-search.json"
target.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(json.dumps({"file": str(target.relative_to(ROOT)), "airportCount": len(airports)}))
