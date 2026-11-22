import copy
import csv
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from fastapi import HTTPException

import app
from app import classify_risk
from train import DelayLSTM, FEATURES, SEQUENCE_LENGTH, load_and_engineer


def fixture_metadata():
    """Controlled contract fixture, never a claim of trained predictive quality."""
    return {
        "model_version": "delay-lstm-v2", "region": "US", "production_ready": True,
        "feature_names": FEATURES, "sequence_length": SEQUENCE_LENGTH,
        "feature_mean": [0.0] * len(FEATURES), "feature_scale": [1.0] * len(FEATURES),
        "calibration": {"slope": 1.0, "intercept": 0.0},
        "risk_thresholds": {"medium": 0.2, "high": 0.5},
        "target": "Arrival delay >= 15 minutes", "test_windows": 100,
        "chronological_calibration_cutoff": "2025-07-21", "date_max": "2025-12-31",
        "route_history": {"AA|JFK|LAX": [[0.0] * len(FEATURES)] * 3},
        "route_distance": {"JFK|LAX": 2475},
    }


def fixture_flight(**changes):
    return app.FlightInput(**{
        "origin": "JFK", "destination": "LAX", "flightNumber": "AA100",
        "departureAt": "2026-11-20T09:45:00-05:00", "durationMinutes": 360, "stops": 0,
        **changes,
    })


class FixedLogit:
    def __init__(self, logit=0.0):
        self.logit = logit
        self.input = None

    def __call__(self, values):
        self.input = values.numpy()
        return torch.tensor([self.logit])


class RiskBandTests(unittest.TestCase):
    def test_model_metadata_drives_risk_bands(self):
        metadata = {"risk_thresholds": {"medium": 0.17, "high": 0.50}}
        self.assertEqual(classify_risk(0.16, metadata), "low")
        self.assertEqual(classify_risk(0.17, metadata), "medium")
        self.assertEqual(classify_risk(0.49, metadata), "medium")
        self.assertEqual(classify_risk(0.50, metadata), "high")

    def test_invalid_risk_bands_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "risk thresholds"):
            classify_risk(0.3, {"risk_thresholds": {"medium": 0.7, "high": 0.5}})


class InferenceContractTests(unittest.TestCase):
    def test_current_features_match_the_existing_training_preprocessor(self):
        metadata = fixture_metadata()
        metadata["route_distance"]["JFK|LAX"] = 5
        row = {"FlightDate": "2026-11-20", "Reporting_Airline": "AA", "Origin": "JFK", "Dest": "LAX", "CRSDepTime": 945, "CRSElapsedTime": 5, "Distance": 5, "ArrDelay": 0, "Cancelled": 0}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "controlled-bts-row.csv"
            with path.open("w", newline="") as source:
                writer = csv.DictWriter(source, fieldnames=row)
                writer.writeheader()
                writer.writerow(row)
            expected = load_and_engineer(path)[FEATURES].to_numpy(dtype=np.float32)[0]
        actual = app.inference_sequence(fixture_flight(durationMinutes=5), metadata, "AA|JFK|LAX")
        np.testing.assert_allclose(actual[0, -1], expected, atol=1e-7)
        self.assertEqual(actual.shape, (1, SEQUENCE_LENGTH, len(FEATURES)))

    def test_offset_timestamp_is_converted_to_origin_local_date_and_hour(self):
        metadata = fixture_metadata()
        local = app.inference_sequence(fixture_flight(departureAt="2026-11-20T23:45:00-05:00"), metadata, "AA|JFK|LAX")
        utc = app.inference_sequence(fixture_flight(departureAt="2026-11-21T04:45:00Z"), metadata, "AA|JFK|LAX")
        np.testing.assert_array_equal(local, utc)

    def test_sequence_preserves_feature_order_and_prior_normalization(self):
        metadata = fixture_metadata()
        metadata["feature_mean"] = [0.1] * 10
        metadata["feature_scale"] = [2.0] * 10
        metadata["route_history"]["AA|JFK|LAX"] = [[float(index)] * 10 for index in range(12)]
        sequence = app.inference_sequence(fixture_flight(), metadata, "AA|JFK|LAX")
        self.assertEqual(sequence.shape, (1, 10, 10))
        np.testing.assert_array_equal(sequence[0, :-1, 0], np.arange(3, 12))
        np.testing.assert_allclose(sequence[0, -1, 8:], [11, 11])

    def test_calibrated_probability_and_supported_scope(self):
        model = FixedLogit(-1.0)
        with patch.multiple(app, model=model, metadata=fixture_metadata()):
            result = app.predict(fixture_flight())
        self.assertAlmostEqual(result["probability"], 1 / (1 + math.exp(1)))
        self.assertEqual(result["riskLevel"], "medium")
        self.assertEqual(result["modelRegion"], "US")
        self.assertEqual(result["evaluation"]["testPeriodStart"], "2025-07-22")
        self.assertIn("arrival", result["target"].lower())

    def test_invalid_or_unsupported_requests_fail_without_probability(self):
        for changes in [{"stops": 1}, {"departureAt": "not-a-valid-departure"}, {"flightNumber": "ZZ100"}, {"destination": "DEL"}]:
            with self.subTest(changes=changes), patch.multiple(app, model=FixedLogit(), metadata=fixture_metadata()):
                with self.assertRaises(HTTPException) as raised:
                    app.predict(fixture_flight(**changes))
                self.assertEqual(raised.exception.status_code, 422)

    def test_nonfinite_model_logit_is_unavailable(self):
        with patch.multiple(app, model=FixedLogit(float("nan")), metadata=fixture_metadata()):
            with self.assertRaises(HTTPException) as raised:
                app.predict(fixture_flight())
        self.assertEqual(raised.exception.status_code, 503)

    def test_metadata_validation_rejects_corrupt_inference_inputs(self):
        app.validate_metadata(fixture_metadata())
        changes = [
            {"feature_names": list(reversed(FEATURES))}, {"sequence_length": 9},
            {"feature_scale": [0.0] * 10}, {"feature_mean": [float("nan")] * 10},
            {"calibration": {"slope": float("inf"), "intercept": 0}},
            {"route_history": {"AA|JFK|LAX": [[0.0]]}},
            {"route_history": {"AA|JFK|LAX": []}}, {"route_distance": {}},
            {"test_windows": 0}, {"chronological_calibration_cutoff": "2026-01-01"},
        ]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                app.validate_metadata({**copy.deepcopy(fixture_metadata()), **change})

    def test_read_artifact_loads_only_the_installed_matching_validated_schema(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            metadata = fixture_metadata()
            (root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            torch.save(DelayLSTM().state_dict(), root / "delay-lstm-v2.pt")
            loaded, details = app.read_artifact(root, "US")
            self.assertIsInstance(loaded, DelayLSTM)
            self.assertFalse(loaded.training)
            self.assertEqual(details["model_version"], "delay-lstm-v2")
            self.assertEqual(app.read_artifact(root, "IN"), (None, None))
            metadata["feature_scale"][0] = 0
            (root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            self.assertEqual(app.read_artifact(root, "US"), (None, None))


class HttpContractTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, path, body=None):
        messages = []

        async def receive():
            return {"type": "http.request", "body": json.dumps(body).encode() if body else b"", "more_body": False}

        async def send(message):
            messages.append(message)

        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST" if body is not None else "GET", "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"", "headers": [(b"content-type", b"application/json")], "server": ("127.0.0.1", 8001), "client": ("127.0.0.1", 1234), "root_path": ""}
        await app.app(scope, receive, send)
        status = next(message["status"] for message in messages if message["type"] == "http.response.start")
        payload = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        return status, json.loads(payload)

    async def test_predict_endpoint_validates_inputs_and_returns_calibrated_contract(self):
        with patch.multiple(app, model=FixedLogit(), metadata=fixture_metadata()):
            status, result = await self.request("/predict", fixture_flight().model_dump())
            self.assertEqual(status, 200)
            self.assertEqual(result["probability"], 0.5)
            self.assertEqual(result["riskLevel"], "high")
            status, _ = await self.request("/predict", {"origin": "invalid"})
            self.assertEqual(status, 422)

    async def test_missing_model_is_live_but_not_model_ready(self):
        with patch.multiple(app, model=None, metadata=None, india_model=None, india_metadata=None):
            status, result = await self.request("/health")
            self.assertEqual(status, 200)
            self.assertFalse(result["available"])
            status, _ = await self.request("/readyz")
            self.assertEqual(status, 503)
            status, _ = await self.request("/predict", fixture_flight().model_dump())
            self.assertEqual(status, 503)

    async def test_ready_model_reports_only_supported_installed_regions(self):
        with patch.multiple(app, model=FixedLogit(), metadata=fixture_metadata(), india_model=None, india_metadata=None):
            status, result = await self.request("/readyz")
            self.assertEqual(status, 200)
            self.assertEqual(result["regions"], {"US": "delay-lstm-v2", "IN": None})


if __name__ == "__main__":
    unittest.main()
