import unittest

import pandas as pd

from build_weather_training_data import join_chunk, scheduled_utc
from join_historical_weather import WEATHER_FIELDS


class WeatherTrainingJoinTests(unittest.TestCase):
    def test_prediction_cutoff_excludes_observation_too_close_to_departure(self):
        flights = pd.DataFrame([{"FlightDate": "2023-01-01", "Origin": "JFK", "CRSDepTime": 1000}])
        times = ["2023-01-01T07:59:00Z", "2023-01-01T08:00:00Z", "2023-01-01T09:14:00Z", "2023-01-01T09:16:00Z"]
        weather = pd.DataFrame({"observedAtUtc": pd.to_datetime(times, utc=True), **{field: [1, 2, 3, 4] for field in WEATHER_FIELDS}})
        joined = join_chunk(flights, {"JFK": {"timezone": "UTC", "ghcn_id": "station"}}, {"station": weather})
        self.assertEqual(joined.loc[0, "temperature"], 3)
        self.assertEqual(joined.loc[0, "weatherAgeMinutes"], 46)

    def test_invalid_and_ambiguous_local_schedule_is_excluded(self):
        flights = pd.DataFrame([
            {"FlightDate": "2023-11-05", "CRSDepTime": 130},
            {"FlightDate": "2023-11-05", "CRSDepTime": 1260},
            {"FlightDate": "2023-11-05", "CRSDepTime": 1030},
        ])
        times = scheduled_utc(flights, "America/New_York")
        self.assertTrue(pd.isna(times.iloc[0]))
        self.assertTrue(pd.isna(times.iloc[1]))
        self.assertEqual(times.iloc[2], pd.Timestamp("2023-11-05T15:30:00Z"))


if __name__ == "__main__":
    unittest.main()
