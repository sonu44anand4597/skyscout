"""Smoke-check installed regional artifacts without claiming a real flight forecast."""
from datetime import datetime, timedelta, timezone

import app

app.load_artifact()
health = app.health()
if not health["regions"]["US"]:
    raise SystemExit("US production artifact did not load")
carrier, origin, destination = next(iter(app.metadata["route_history"])).split("|")
flight = app.FlightInput(
    origin=origin, destination=destination, flightNumber=f"{carrier}123",
    departureAt=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
    durationMinutes=120, stops=0,
)
result = app.predict(flight)
if result["modelRegion"] != "US" or not 0 <= result["probability"] <= 1:
    raise SystemExit("US regional prediction smoke-check failed")
print({"US": health["regions"]["US"], "India": health["regions"]["IN"], "US_inference": "passed"})
