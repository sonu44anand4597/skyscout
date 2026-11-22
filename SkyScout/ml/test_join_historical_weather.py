import unittest

import pandas as pd

from join_historical_weather import join_departures


class HistoricalWeatherJoinTests(unittest.TestCase):
    def test_join_uses_only_recent_observations_at_or_before_departure(self):
        departures = pd.DataFrame({
            "departureAtUtc": pd.to_datetime(["2023-01-01T10:00:00Z", "2023-01-01T15:00:00Z", "2023-01-01T18:00:00Z"]),
            "significantDelay": [0, 1, 0],
        })
        weather = pd.DataFrame({
            "observedAtUtc": pd.to_datetime(["2023-01-01T09:00:00Z", "2023-01-01T10:30:00Z", "2023-01-01T17:30:00Z", "2023-01-01T18:15:00Z"]),
            "wind_speed": [1.0, 2.0, 3.0, 4.0],
        })
        joined = join_departures(departures, weather)
        self.assertEqual(joined["wind_speed"].iloc[0], 1.0)
        self.assertTrue(pd.isna(joined["wind_speed"].iloc[1]))
        self.assertEqual(joined["wind_speed"].iloc[2], 3.0)
        self.assertEqual(joined["weatherAgeMinutes"].dropna().tolist(), [60.0, 30.0])


if __name__ == "__main__":
    unittest.main()
