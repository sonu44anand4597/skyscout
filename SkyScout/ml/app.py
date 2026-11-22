"""Prediction-only service. Model training is a separate offline CLI operation."""
from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from train import DelayLSTM, FEATURES, SEQUENCE_LENGTH
from india_support import indian_carrier, region as flight_region

MODEL_DIR = Path(os.getenv("SKYSCOUT_MODEL_DIR", Path(__file__).parent / "artifacts"))
METADATA_PATH = MODEL_DIR / "metadata.json"
app = FastAPI(title="SkyScout delay inference", version="1.0.0")
model = None
metadata = None
india_model = None
india_metadata = None
AIRPORT_TIMEZONES = json.loads((Path(__file__).resolve().parents[1] / "backend/data/airport-locations.json").read_text(encoding="utf-8"))["airports"]


class FlightInput(BaseModel):
    origin: str = Field(pattern=r"^[A-Z]{3}$")
    destination: str = Field(pattern=r"^[A-Z]{3}$")
    flightNumber: str = Field(min_length=2, max_length=16)
    departureAt: str = Field(min_length=16, max_length=32)
    durationMinutes: int = Field(gt=0, le=1500)
    stops: int = Field(ge=0, le=5)
    airline: str | None = Field(default=None, max_length=100)


def resolved_risk_thresholds(model_metadata: dict) -> dict[str, float]:
    thresholds = model_metadata.get("risk_thresholds") or {}
    medium = float(thresholds.get("medium", model_metadata.get("metrics", {}).get("threshold", 0.2)))
    high = float(thresholds.get("high", max(0.5, medium + 0.3)))
    if not 0 <= medium < high <= 1:
        raise ValueError("Model risk thresholds must satisfy 0 <= medium < high <= 1.")
    return {"medium": medium, "high": high}


def classify_risk(probability: float, model_metadata: dict) -> str:
    thresholds = resolved_risk_thresholds(model_metadata)
    medium = thresholds["medium"]
    high = thresholds["high"]
    return "low" if probability < medium else "medium" if probability < high else "high"


def validate_metadata(artifact_metadata: dict) -> None:
    """Fail closed before loading weights when the inference contract is corrupt."""
    if artifact_metadata.get("feature_names") != FEATURES or artifact_metadata.get("sequence_length") != SEQUENCE_LENGTH:
        raise ValueError("Model feature schema does not match inference.")
    mean = np.asarray(artifact_metadata.get("feature_mean"), dtype=np.float32)
    scale = np.asarray(artifact_metadata.get("feature_scale"), dtype=np.float32)
    if mean.shape != (len(FEATURES),) or scale.shape != mean.shape or not np.isfinite(mean).all() or not np.isfinite(scale).all() or np.any(scale <= 0):
        raise ValueError("Model normalization must contain ten finite means and positive scales.")
    calibration = artifact_metadata.get("calibration") or {}
    if not all(isinstance(calibration.get(key), (float, int)) and math.isfinite(calibration[key]) for key in ("slope", "intercept")):
        raise ValueError("Model probability calibration is invalid.")
    resolved_risk_thresholds(artifact_metadata)
    if not artifact_metadata.get("target") or not isinstance(artifact_metadata.get("test_windows"), int) or artifact_metadata["test_windows"] <= 0:
        raise ValueError("Model evaluation provenance is missing.")
    cutoff = datetime.fromisoformat(artifact_metadata["chronological_calibration_cutoff"])
    if cutoff >= datetime.fromisoformat(artifact_metadata["date_max"]):
        raise ValueError("Model test period must follow calibration.")
    histories = artifact_metadata.get("route_history")
    distances = artifact_metadata.get("route_distance")
    if not isinstance(histories, dict) or not histories or not isinstance(distances, dict):
        raise ValueError("Model route histories are missing.")
    for key, history in histories.items():
        parts = key.split("|")
        values = np.asarray(history, dtype=np.float32)
        distance = distances.get("|".join(parts[1:]))
        if len(parts) != 3 or values.ndim != 2 or values.shape[0] == 0 or values.shape[1] != len(FEATURES) or not np.isfinite(values).all() or not isinstance(distance, (int, float)) or not math.isfinite(distance) or distance <= 0:
            raise ValueError("Model route history or distance is invalid.")


def scheduled_local_time(value: str, origin: str) -> datetime:
    try:
        scheduled = datetime.fromisoformat(value.replace("Z", "+00:00"))
        zone = ZoneInfo(AIRPORT_TIMEZONES[origin]["timezone"])
        # Provider wall times are already airport-local. Offset-bearing values
        # are instants and must be converted to the same BTS local-time basis.
        return scheduled.replace(tzinfo=zone) if scheduled.tzinfo is None else scheduled.astimezone(zone)
    except (ValueError, KeyError, ZoneInfoNotFoundError) as error:
        raise HTTPException(status_code=422, detail="Scheduled departure or origin timezone is invalid.") from error


def inference_sequence(flight: FlightInput, selected_metadata: dict, route_key: str) -> np.ndarray:
    scheduled = scheduled_local_time(flight.departureAt, flight.origin)
    history = selected_metadata["route_history"].get(route_key)
    distance = selected_metadata["route_distance"].get(f"{flight.origin}|{flight.destination}")
    if not history or distance is None:
        raise HTTPException(status_code=422, detail="Delay estimate currently unavailable for this flight. No matching airline-route history exists in the trained model.")
    mean = np.asarray(selected_metadata["feature_mean"], dtype=np.float32)
    scale = np.asarray(selected_metadata["feature_scale"], dtype=np.float32)
    prior = np.asarray(history[-1], dtype=np.float32) * scale + mean
    # These transformations deliberately match load_and_engineer in train.py,
    # including whole scheduled hours and the original clipping bounds.
    hour, weekday, month = scheduled.hour, scheduled.weekday(), scheduled.month
    values = np.asarray([
        math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24),
        math.sin(2 * math.pi * weekday / 7), math.cos(2 * math.pi * weekday / 7),
        math.sin(2 * math.pi * month / 12), math.cos(2 * math.pi * month / 12),
        min(max(flight.durationMinutes, 20), 1000) / 600,
        min(max(float(distance), 10), 6000) / 5000,
        prior[8], prior[9],
    ], dtype=np.float32)
    current = (values - mean) / scale
    sequence = [np.asarray(item, dtype=np.float32) for item in history[-(SEQUENCE_LENGTH - 1):]] + [current]
    if len(sequence) < SEQUENCE_LENGTH:
        sequence = [sequence[0]] * (SEQUENCE_LENGTH - len(sequence)) + sequence
    return np.stack(sequence)[None, ...]


def read_artifact(directory: Path, expected_region: str):
    path = directory / "metadata.json"
    if not path.is_file():
        return None, None
    try:
        artifact_metadata = json.loads(path.read_text(encoding="utf-8"))
        if artifact_metadata.get("production_ready") is not True or artifact_metadata.get("region", "US") != expected_region:
            return None, None
        validate_metadata(artifact_metadata)
        version = artifact_metadata.get("model_version", "")
        if not re.fullmatch(r"delay-lstm-v[1-9]\d*", version):
            raise ValueError("Model version is invalid.")
        weights_path = directory / f"{version}.pt"
        if not weights_path.is_file():
            raise FileNotFoundError("Model weights for this version are missing.")
        loaded_model = DelayLSTM()
        state = torch.load(weights_path, map_location="cpu", weights_only=True)
        loaded_model.load_state_dict(state)
        loaded_model.eval()
        return loaded_model, artifact_metadata
    except Exception as error:
        print(f"{expected_region} delay model artifact could not be loaded: {error}")
        return None, None


@app.on_event("startup")
def load_artifact() -> None:
    global model, metadata, india_model, india_metadata
    model, metadata = read_artifact(MODEL_DIR, "US")
    india_model, india_metadata = read_artifact(MODEL_DIR / "india", "IN")


@app.get("/health")
def health() -> dict:
    return {"available": model is not None or india_model is not None, "modelVersion": metadata.get("model_version") if metadata else None, "regions": {"US": metadata.get("model_version") if metadata else None, "IN": india_metadata.get("model_version") if india_metadata else None}}


@app.get("/readyz")
def readiness() -> dict:
    status = health()
    if not status["available"]:
        raise HTTPException(status_code=503, detail="No validated regional delay model is installed.")
    return status


@app.post("/predict")
def predict(flight: FlightInput) -> dict:
    region = flight_region(flight.origin, flight.destination)
    if region is None:
        raise HTTPException(status_code=422, detail="Delay estimate currently unavailable for this flight's region or airport pair.")
    selected_model, selected_metadata = (india_model, india_metadata) if region == "IN" else (model, metadata)
    if selected_model is None or selected_metadata is None:
        raise HTTPException(status_code=503, detail=f"Delay estimate currently unavailable for this flight. No validated {region} LSTM artifact is installed.")
    if flight.stops != 0:
        raise HTTPException(status_code=422, detail="The trained model supports nonstop flights only.")
    carrier_match = re.match(r"^([A-Z0-9]{2})\s*\d", flight.flightNumber.upper())
    carrier = carrier_match.group(1) if carrier_match else ""
    if region == "IN":
        carrier = indian_carrier(carrier) or indian_carrier(flight.airline or "") or ""
    route_key = f"{carrier}|{flight.origin}|{flight.destination}"
    sequence = inference_sequence(flight, selected_metadata, route_key)
    with torch.no_grad():
        logit = float(selected_model(torch.from_numpy(sequence)).item())
    if not math.isfinite(logit):
        raise HTTPException(status_code=503, detail="Delay model returned an invalid estimate.")
    calibration = selected_metadata["calibration"]
    probability = 1 / (1 + math.exp(-max(-40, min(40, calibration["slope"] * logit + calibration["intercept"]))))
    level = classify_risk(probability, selected_metadata)
    return {
        "probability": probability,
        "riskLevel": level,
        "modelVersion": selected_metadata["model_version"],
        "modelRegion": region,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "target": selected_metadata["target"],
        "scope": f"{region} domestic nonstop routes represented in the validated training data",
        "metrics": selected_metadata.get("metrics"),
        "riskThresholds": resolved_risk_thresholds(selected_metadata),
        "evaluation": {
            "testPeriodStart": (datetime.fromisoformat(selected_metadata["chronological_calibration_cutoff"]).date() + timedelta(days=1)).isoformat(),
            "testPeriodEnd": selected_metadata["date_max"],
            "testWindows": selected_metadata["test_windows"],
        },
    }
