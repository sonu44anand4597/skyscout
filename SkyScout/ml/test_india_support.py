import unittest

from fastapi import HTTPException

import app
from india_support import indian_carrier, region
from prepare_india_flights import convert_row, observed_timestamp


class IndiaSupportTests(unittest.TestCase):
    def test_airports_and_carriers_are_resolved_without_guessing(self):
        self.assertEqual(region("DEL", "BOM"), "IN")
        self.assertEqual(region("HYD", "CCU"), "IN")
        self.assertEqual(region("JFK", "LAX"), "US")
        self.assertIsNone(region("DEL", "JFK"))
        self.assertEqual(indian_carrier("IndiGo"), "6E")
        self.assertIsNone(indian_carrier("Unknown Air"))

    def test_importer_converts_explicit_utc_timestamps_to_ist(self):
        row = {
            "flight_number": "6E123", "airline": "IndiGo", "origin": "DEL", "destination": "BOM",
            "scheduled_departure": "2026-10-06T23:30:00+00:00",
            "scheduled_arrival": "2026-10-07T01:30:00+00:00",
            "actual_arrival": "2026-10-07T01:50:00+00:00",
            "distance_miles": "710", "cancelled": "false",
        }
        converted = convert_row(row)
        self.assertEqual(converted["FlightDate"], "2026-10-07")
        self.assertEqual(converted["CRSDepTime"], 500)
        self.assertEqual(converted["ArrDelay"], 20)

    def test_importer_rejects_undated_or_aggregate_information(self):
        with self.assertRaisesRegex(ValueError, "timezone offset"):
            observed_timestamp("2026-10-07T05:00:00")
        with self.assertRaises(KeyError):
            convert_row({"airline": "IndiGo", "otp": "91%"})

    def test_india_without_validated_model_has_no_probability(self):
        flight = app.FlightInput(origin="DEL", destination="BOM", flightNumber="6E123", departureAt="2026-10-08T05:00:00+05:30", durationMinutes=120, stops=0)
        with self.assertRaises(HTTPException) as raised:
            app.predict(flight)
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
