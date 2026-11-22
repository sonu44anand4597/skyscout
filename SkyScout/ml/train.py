"""Train a chronological LSTM for BTS domestic-flight arrival delay >= 15 minutes."""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import random
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset
from india_support import region as airport_region

MODEL_VERSION = "delay-lstm-v2"
SEQUENCE_LENGTH = 10
FEATURES = ["dep_sin", "dep_cos", "dow_sin", "dow_cos", "month_sin", "month_cos", "scheduled_duration", "distance", "prior_delay_rate", "prior_delay"]
WEATHER_RAW = ["temperature", "wind_speed", "visibility", "ceiling_height", "precipitation", "weatherAgeMinutes"]
WEATHER_FEATURES = [f"weather_{name}" for name in WEATHER_RAW] + [f"weather_{name}_present" for name in WEATHER_RAW[:-1]]
REQUIRED = ["FlightDate", "Reporting_Airline", "Origin", "Dest", "CRSDepTime", "CRSElapsedTime", "Distance", "ArrDelay", "Cancelled"]
CSV_DTYPES = {
    "Reporting_Airline": "category",
    "Origin": "category",
    "Dest": "category",
    "CRSDepTime": "float32",
    "CRSElapsedTime": "float32",
    "Distance": "float32",
    "ArrDelay": "float32",
    "Cancelled": "float32",
}


class DelayLSTM(nn.Module):
    def __init__(self, input_size: int = len(FEATURES), hidden_size: int = 48):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers=1, batch_first=True)
        self.dropout = nn.Dropout(0.2)
        self.output = nn.Linear(hidden_size, 1)

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        _, (hidden, _) = self.lstm(values)
        return self.output(self.dropout(hidden[-1])).squeeze(-1)


def dataset_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fit_platt_scaling(logits: np.ndarray, labels: np.ndarray) -> tuple[float, float]:
    values = np.asarray(logits, dtype=np.float64).reshape(-1)
    targets = np.asarray(labels, dtype=np.float64).reshape(-1)
    if values.size != targets.size or values.size == 0 or not np.isfinite(values).all():
        raise ValueError("Calibration logits must be finite and match the label count.")
    positives = float(targets.sum())
    negatives = float(targets.size - positives)
    if positives <= 0 or negatives <= 0:
        raise ValueError("Calibration data needs both delayed and on-time flights.")

    center = float(values.mean())
    spread = float(values.std()) or 1.0
    standardized = (values - center) / spread
    parameters = np.asarray([0.0, np.log(positives / negatives)], dtype=np.float64)

    def objective(candidate: np.ndarray) -> float:
        scores = candidate[0] * standardized + candidate[1]
        return float(np.logaddexp(0, scores).sum() - np.dot(targets, scores))

    current_loss = objective(parameters)
    for _ in range(100):
        scores = parameters[0] * standardized + parameters[1]
        probabilities = 1.0 / (1.0 + np.exp(-np.clip(scores, -40, 40)))
        residual = probabilities - targets
        weights = probabilities * (1.0 - probabilities)
        gradient = np.asarray([np.dot(standardized, residual), residual.sum()])
        if np.max(np.abs(gradient)) < 1e-8:
            break
        hessian = np.asarray([
            [np.dot(standardized * standardized, weights), np.dot(standardized, weights)],
            [np.dot(standardized, weights), weights.sum()],
        ])
        hessian[0, 0] += 1e-8
        hessian[1, 1] += 1e-8
        try:
            step = np.linalg.solve(hessian, gradient)
        except np.linalg.LinAlgError:
            break
        fraction = 1.0
        while fraction >= 1e-6:
            candidate = parameters - fraction * step
            candidate_loss = objective(candidate)
            if candidate_loss <= current_loss:
                parameters = candidate
                if current_loss - candidate_loss < 1e-10:
                    current_loss = candidate_loss
                    fraction = 0
                    break
                current_loss = candidate_loss
                break
            fraction *= 0.5
        if fraction < 1e-6:
            break

    slope = float(parameters[0] / spread)
    intercept = float(parameters[1] - parameters[0] * center / spread)
    return slope, intercept


def choose_f1_threshold(labels: np.ndarray, probabilities: np.ndarray) -> float:
    targets = np.asarray(labels, dtype=np.int64).reshape(-1)
    scores = np.asarray(probabilities, dtype=np.float64).reshape(-1)
    if targets.size != scores.size or targets.size == 0 or not np.isfinite(scores).all():
        raise ValueError("Threshold-selection probabilities must be finite and match the label count.")
    positives = int(np.count_nonzero(targets == 1))
    if positives == 0:
        raise ValueError("Threshold selection needs at least one delayed flight.")
    order = np.argsort(scores, kind="stable")[::-1]
    ordered_scores = scores[order]
    ordered_positive = (targets[order] == 1).astype(np.int64)
    true_positives = np.cumsum(ordered_positive)
    predicted_counts = np.arange(1, scores.size + 1)
    last_for_score = np.r_[ordered_scores[:-1] != ordered_scores[1:], True]
    candidate_indices = np.flatnonzero(last_for_score)
    precision = true_positives[candidate_indices] / predicted_counts[candidate_indices]
    recall = true_positives[candidate_indices] / positives
    f1 = np.divide(2 * precision * recall, precision + recall, out=np.zeros_like(precision), where=(precision + recall) > 0)
    return float(ordered_scores[candidate_indices[int(np.argmax(f1))]])


def evaluation_metrics(labels: np.ndarray, probabilities: np.ndarray, threshold: float = 0.5) -> dict[str, float | None]:
    targets = np.asarray(labels, dtype=np.int64).reshape(-1)
    scores = np.asarray(probabilities, dtype=np.float64).reshape(-1)
    if targets.size != scores.size or targets.size == 0 or not np.isfinite(scores).all():
        raise ValueError("Evaluation probabilities must be finite and match the label count.")
    if not 0 <= threshold <= 1 or np.any((targets != 0) & (targets != 1)) or np.any((scores < 0) | (scores > 1)):
        raise ValueError("Evaluation requires binary labels, probabilities in [0, 1], and a threshold in [0, 1].")
    predicted = scores >= threshold
    positive = targets == 1
    true_positive = int(np.count_nonzero(predicted & positive))
    false_positive = int(np.count_nonzero(predicted & ~positive))
    false_negative = int(np.count_nonzero(~predicted & positive))
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    auc = None
    if positive.any() and (~positive).any():
        order = np.argsort(scores, kind="stable")
        sorted_scores = scores[order]
        sorted_positive = positive[order]
        _, first, counts = np.unique(sorted_scores, return_index=True, return_counts=True)
        ranks = np.empty(scores.size, dtype=np.float64)
        for start, count in zip(first, counts):
            end = start + count
            ranks[start:end] = ((start + 1) + end) / 2
        positive_ranks = ranks[sorted_positive].sum()
        positive_count = int(positive.sum())
        negative_count = int((~positive).sum())
        auc = float((positive_ranks - positive_count * (positive_count + 1) / 2) / (positive_count * negative_count))
    return {
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "confusion_matrix_labels": [0, 1],
        "confusion_matrix": [[int(np.count_nonzero(~positive & ~predicted)), false_positive], [false_negative, true_positive]],
        "roc_auc": auc,
        "brier_score": float(np.mean((scores - targets) ** 2)),
        "threshold": float(threshold),
        "threshold_selection": "F1 maximized on the separate chronological calibration period",
        "calibration": "Platt scaling fitted on the separate chronological calibration period",
    }


def load_and_engineer(path: Path, with_weather: bool = False) -> pd.DataFrame:
    required = REQUIRED + (WEATHER_RAW if with_weather else [])
    read_options = {"usecols": lambda name: name in required, "dtype": CSV_DTYPES, "low_memory": False}
    if path.suffix.lower() == ".zip":
        with ZipFile(path) as archive:
            csv_members = [name for name in archive.namelist() if name.lower().endswith(".csv") and not name.startswith("__MACOSX/")]
            if len(csv_members) != 1:
                raise ValueError("BTS ZIP archives must contain exactly one CSV file.")
            with archive.open(csv_members[0]) as source:
                frame = pd.read_csv(source, **read_options)
    else:
        frame = pd.read_csv(path, **read_options)
    missing = sorted(set(required) - set(frame.columns))
    if missing:
        raise ValueError("BTS CSV is missing required columns: " + ", ".join(missing))
    frame["FlightDate"] = pd.to_datetime(frame["FlightDate"], errors="coerce")
    for field in ["CRSDepTime", "CRSElapsedTime", "Distance", "ArrDelay", "Cancelled"]:
        frame[field] = pd.to_numeric(frame[field], errors="coerce")
    frame = frame.dropna(subset=["FlightDate", "Reporting_Airline", "Origin", "Dest", "CRSDepTime", "CRSElapsedTime", "Distance", "ArrDelay", "Cancelled"])
    frame = frame[(frame["Cancelled"].fillna(0) == 0) & (frame["CRSElapsedTime"] > 0) & (frame["Distance"] > 0)].copy()
    frame["label"] = (frame["ArrDelay"] >= 15).astype("float32")
    dep_hour = np.floor(frame["CRSDepTime"].clip(0, 2359) / 100).clip(0, 23)
    frame["dep_sin"] = np.sin(2 * np.pi * dep_hour / 24).astype("float32")
    frame["dep_cos"] = np.cos(2 * np.pi * dep_hour / 24).astype("float32")
    weekday = frame["FlightDate"].dt.dayofweek
    frame["dow_sin"] = np.sin(2 * np.pi * weekday / 7).astype("float32")
    frame["dow_cos"] = np.cos(2 * np.pi * weekday / 7).astype("float32")
    month = frame["FlightDate"].dt.month
    frame["month_sin"] = np.sin(2 * np.pi * month / 12).astype("float32")
    frame["month_cos"] = np.cos(2 * np.pi * month / 12).astype("float32")
    frame["scheduled_duration"] = (frame["CRSElapsedTime"].clip(20, 1000) / 600).astype("float32")
    frame["distance"] = (frame["Distance"].clip(10, 6000) / 5000).astype("float32")
    if with_weather:
        scales = {"temperature": 40, "wind_speed": 30, "visibility": 20, "ceiling_height": 3000, "precipitation": 10, "weatherAgeMinutes": 120}
        bounds = {"temperature": (-80, 60), "wind_speed": (0, 100), "visibility": (0, 100), "ceiling_height": (0, 30000), "precipitation": (0, 1000), "weatherAgeMinutes": (45, 120)}
        for name in WEATHER_RAW:
            values = pd.to_numeric(frame[name], errors="coerce")
            low, high = bounds[name]
            values = values.where(values.between(low, high))
            if name != "weatherAgeMinutes":
                frame[f"weather_{name}_present"] = values.notna().astype("float32")
            frame[f"weather_{name}"] = (values.clip(low, high).fillna(0) / scales[name]).astype("float32")
    keys = ["Reporting_Airline", "Origin", "Dest"]
    frame = frame.sort_values([*keys, "FlightDate", "CRSDepTime"], kind="stable").reset_index(drop=True)
    daily = frame.groupby([*keys, "FlightDate"], as_index=False, sort=True, observed=True).agg(
        _daily_mean_arrival_delay=("ArrDelay", "mean"),
        _daily_delay_rate=("label", "mean"),
    )
    daily = daily.sort_values([*keys, "FlightDate"], kind="stable").reset_index(drop=True)
    daily_groups = daily.groupby(keys, sort=False, observed=True)
    daily["prior_delay"] = (daily_groups["_daily_mean_arrival_delay"].shift(1).clip(-60, 180).fillna(0) / 180).astype("float32")
    daily["prior_delay_rate"] = daily.groupby(keys, sort=False, observed=True)["_daily_delay_rate"].transform(
        lambda series: series.shift(1).rolling(30, min_periods=3).mean()
    ).fillna(0).astype("float32")
    frame = frame.merge(daily[[*keys, "FlightDate", "prior_delay", "prior_delay_rate"]], on=[*keys, "FlightDate"], how="left", validate="many_to_one")
    frame = frame.sort_values([*keys, "FlightDate", "CRSDepTime"], kind="stable").reset_index(drop=True)
    frame["_position"] = np.arange(len(frame), dtype=np.int32)
    return frame


def training_feature_stats(frame: pd.DataFrame, train_cutoff: pd.Timestamp, chunk_size: int = 200_000) -> tuple[np.ndarray, np.ndarray]:
    total = np.zeros(len(FEATURES), dtype=np.float64)
    sum_squares = np.zeros(len(FEATURES), dtype=np.float64)
    count = 0
    for start in range(0, len(frame), chunk_size):
        chunk = frame.iloc[start:start + chunk_size]
        values = chunk.loc[chunk["FlightDate"] <= train_cutoff, FEATURES].to_numpy(dtype=np.float64)
        if values.size == 0:
            continue
        total += values.sum(axis=0)
        sum_squares += np.square(values).sum(axis=0)
        count += values.shape[0]
    if count == 0:
        raise ValueError("The chronological training period contains no rows.")
    mean = total / count
    scale = np.sqrt(np.maximum(sum_squares / count - np.square(mean), 0))
    scale[scale < 1e-6] = 1
    return mean.astype(np.float32), scale.astype(np.float32)


def make_sequences(frame: pd.DataFrame, mean: np.ndarray, scale: np.ndarray, train_cutoff: pd.Timestamp, validation_cutoff: pd.Timestamp, max_train: int, max_calibration: int, max_test: int):
    x = ((frame[FEATURES].to_numpy(dtype=np.float32) - mean) / scale).astype(np.float32)
    y = frame["label"].to_numpy(dtype=np.float32)
    date = frame["FlightDate"].to_numpy()
    limits = {"train": max_train, "cal": max_calibration, "test": max_test}
    split_rows = {
        "train": int((frame["FlightDate"] <= train_cutoff).sum()),
        "cal": int(((frame["FlightDate"] > train_cutoff) & (frame["FlightDate"] <= validation_cutoff)).sum()),
        "test": int((frame["FlightDate"] > validation_cutoff).sum()),
    }
    strides = {split: max(1, split_rows[split] // max(limit * 2, 1)) for split, limit in limits.items()}
    sampled_windows: dict[str, list[np.ndarray]] = {split: [] for split in limits}
    seen = {split: 0 for split in limits}
    global_positions = frame["_position"].to_numpy(dtype=np.int32)
    for indices in frame.groupby(["Reporting_Airline", "Origin", "Dest"], sort=False, observed=True).indices.values():
        indices = np.asarray(indices, dtype=np.int64)
        for offset in range(SEQUENCE_LENGTH - 1, len(indices)):
            position = indices[offset]
            target_date = pd.Timestamp(date[position])
            split = "train" if target_date <= train_cutoff else "cal" if target_date <= validation_cutoff else "test"
            if global_positions[position] % strides[split]:
                continue
            window = indices[offset - SEQUENCE_LENGTH + 1: offset + 1]
            seen[split] += 1
            bucket = sampled_windows[split]
            limit = limits[split]
            if len(bucket) < limit:
                bucket.append(window.copy())
            else:
                replacement = int(np.random.randint(0, seen[split]))
                if replacement < limit:
                    bucket[replacement] = window.copy()
    sequences: dict[str, np.ndarray] = {}
    for split, windows in sampled_windows.items():
        windows.sort(key=lambda window: int(global_positions[window[-1]]))
        split_x = np.empty((len(windows), SEQUENCE_LENGTH, len(FEATURES)), dtype=np.float32)
        split_y = np.empty(len(windows), dtype=np.float32)
        for index, window in enumerate(windows):
            split_x[index] = x[window]
            split_y[index] = y[window[-1]]
        sequences[f"{split}_x"] = split_x
        sequences[f"{split}_y"] = split_y
    return sequences


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path, help="BTS Reporting Carrier On-Time Performance CSV")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "artifacts")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--seed", type=int, default=2025)
    parser.add_argument("--max-train", type=int, default=150_000)
    parser.add_argument("--max-calibration", type=int, default=25_000)
    parser.add_argument("--max-test", type=int, default=25_000)
    parser.add_argument("--weather-candidate", action="store_true", help="Train an experimental weather-aware candidate; never install it as the served model")
    parser.add_argument("--region", choices=["US", "IN"], default="US", help="Train separate regional artifacts using the same LSTM architecture")
    args = parser.parse_args()
    if not args.csv.is_file():
        raise SystemExit(f"Dataset not found: {args.csv}")
    if args.epochs < 1 or args.max_train < 500 or args.max_calibration < 100 or args.max_test < 100:
        parser.error("Use at least 1 epoch, 500 training windows, and 100 calibration/test windows.")
    india_manifest = None
    if args.region == "IN":
        if args.weather_candidate:
            parser.error("An Indian weather-aware LSTM requires matched historical training weather and is not enabled.")
        manifest_path = args.csv.with_suffix(args.csv.suffix + ".manifest.json")
        if not manifest_path.is_file():
            parser.error("Indian training requires the provenance manifest from prepare_india_flights.py.")
        india_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if india_manifest.get("record_type") != "observed_individual_flights" or india_manifest.get("processed_sha256") != dataset_hash(args.csv):
            parser.error("Indian flight-level provenance or processed CSV digest is invalid.")
        if args.output.resolve() == (Path(__file__).parent / "artifacts").resolve():
            parser.error("Use --output ml/artifacts/india for Indian training; do not overwrite the US artifact.")

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.use_deterministic_algorithms(True, warn_only=True)
    global FEATURES, MODEL_VERSION
    if args.weather_candidate:
        FEATURES = FEATURES + WEATHER_FEATURES
        MODEL_VERSION = "delay-lstm-v3"
    frame = load_and_engineer(args.csv, with_weather=args.weather_candidate)
    if args.region == "IN" and not all(airport_region(origin, dest) == "IN" for origin, dest in zip(frame["Origin"], frame["Dest"])):
        raise SystemExit("Indian training input contains a non-Indian domestic route.")
    dataset_summary = {
        "eligible_flights": len(frame),
        "delayed_flights": int(frame["label"].sum()),
        "on_time_flights": int(len(frame) - frame["label"].sum()),
        "delayed_fraction": float(frame["label"].mean()),
        "airline_count": int(frame["Reporting_Airline"].nunique()),
        "airport_count": len(set(frame["Origin"].unique()) | set(frame["Dest"].unique())),
        "route_count": int(frame.groupby(["Reporting_Airline", "Origin", "Dest"], observed=True).ngroups),
    }
    print(json.dumps({"dataset_summary": dataset_summary, "date_min": frame["FlightDate"].min().date().isoformat(), "date_max": frame["FlightDate"].max().date().isoformat()}, indent=2), flush=True)
    train_cutoff = frame["FlightDate"].quantile(0.7)
    validation_cutoff = frame["FlightDate"].quantile(0.85)
    mean, scale = training_feature_stats(frame, train_cutoff)
    batches = make_sequences(frame, mean, scale, train_cutoff, validation_cutoff, args.max_train, args.max_calibration, args.max_test)
    if len(batches["train_y"]) < 500 or len(batches["cal_y"]) < 100 or len(batches["test_y"]) < 100:
        raise SystemExit("Not enough chronological route sequences. Supply a full year of BTS records with at least 500 training and 100 calibration/test windows.")

    split_summary = {
        name: {"windows": int(len(batches[f"{name}_y"])), "delayed_fraction": float(batches[f"{name}_y"].mean())}
        for name in ["train", "cal", "test"]
    }
    print(json.dumps({"chronological_cutoffs": {"train": train_cutoff.date().isoformat(), "calibration": validation_cutoff.date().isoformat()}, "window_summary": split_summary}, indent=2), flush=True)
    if len(np.unique(batches["train_y"])) != 2 or len(np.unique(batches["cal_y"])) != 2:
        raise SystemExit("Training and calibration windows each need both on-time and delayed flights.")

    train_x = torch.from_numpy(batches["train_x"])
    train_y = torch.from_numpy(batches["train_y"])
    cal_x = torch.from_numpy(batches["cal_x"])
    cal_y = batches["cal_y"]
    test_x = torch.from_numpy(batches["test_x"])
    test_y = batches["test_y"]
    positive = max(float(train_y.sum()), 1.0)
    pos_weight = torch.tensor([(len(train_y) - positive) / positive])
    model = DelayLSTM(input_size=len(FEATURES))
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    loader = DataLoader(TensorDataset(train_x, train_y), batch_size=512, shuffle=True)
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for values, labels in loader:
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(values), labels)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total += float(loss.detach())
        print(f"epoch={epoch + 1}/{args.epochs} train_loss={total / max(len(loader), 1):.5f}")

    model.eval()
    with torch.no_grad():
        cal_logits = model(cal_x).numpy()
        test_logits = model(test_x).numpy()
    calibration_slope, calibration_intercept = fit_platt_scaling(cal_logits, cal_y)
    calibrated_calibration_probabilities = 1 / (1 + np.exp(-np.clip(calibration_slope * cal_logits + calibration_intercept, -40, 40)))
    threshold = choose_f1_threshold(cal_y, calibrated_calibration_probabilities)
    risk_thresholds = {"medium": threshold, "high": max(0.5, min(0.8, threshold + 0.3))}
    probabilities = 1 / (1 + np.exp(-np.clip(calibration_slope * test_logits + calibration_intercept, -40, 40)))
    metrics = evaluation_metrics(test_y, probabilities, threshold=threshold)
    baseline_brier = float(np.mean((test_y - float(cal_y.mean())) ** 2))
    metrics["calibration_prevalence_baseline_brier"] = baseline_brier
    metrics["brier_skill_score"] = float(1 - metrics["brier_score"] / baseline_brier) if baseline_brier > 0 else None
    evaluation_passed = bool(metrics["roc_auc"] is not None and metrics["roc_auc"] >= 0.55 and metrics["brier_skill_score"] is not None and metrics["brier_skill_score"] > 0)
    artifact_dir = args.output / "candidate" if args.weather_candidate or not evaluation_passed else args.output
    artifact_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), artifact_dir / f"{MODEL_VERSION}.pt")
    metadata = {
        "model_version": MODEL_VERSION,
        "target": "Arrival delay >= 15 minutes; cancelled flights excluded",
        "region": args.region,
        "dataset": "US DOT BTS Reporting Carrier On-Time Performance" if args.region == "US" else india_manifest["source_name"],
        "source_provenance": india_manifest if args.region == "IN" else None,
        "dataset_path": str(args.csv.name),
        "dataset_sha256": dataset_hash(args.csv),
        "date_min": frame["FlightDate"].min().date().isoformat(),
        "date_max": frame["FlightDate"].max().date().isoformat(),
        "dataset_summary": dataset_summary,
        "chronological_train_cutoff": train_cutoff.date().isoformat(),
        "chronological_calibration_cutoff": validation_cutoff.date().isoformat(),
        "feature_names": FEATURES,
        "sequence_length": SEQUENCE_LENGTH,
        "feature_mean": mean.tolist(),
        "feature_scale": scale.tolist(),
        "train_windows": len(train_y),
        "calibration_windows": len(cal_y),
        "test_windows": len(test_y),
        "window_summary": split_summary,
        "calibration": {"slope": calibration_slope, "intercept": calibration_intercept},
        "metrics": metrics,
        "risk_thresholds": risk_thresholds,
        "production_ready": evaluation_passed and not args.weather_candidate,
        "evaluation_gate_passed": evaluation_passed,
        "weather_candidate_only": args.weather_candidate,
        "weather_prediction_lead_minutes": 45 if args.weather_candidate else None,
        "deployment_gate": "test ROC-AUC >= 0.55 and Brier skill score > 0 versus the calibration-prevalence baseline",
        "random_seed": args.seed,
        "epochs": args.epochs,
        "versions": {"python": platform.python_version(), "torch": torch.__version__, "numpy": np.__version__, "pandas": pd.__version__},
        "route_history": {},
        "route_distance": {},
    }
    if not args.weather_candidate:
        for key, group in frame.groupby(["Reporting_Airline", "Origin", "Dest"], sort=False, observed=True):
            route_key = "|".join(map(str, key))
            tail = group.tail(SEQUENCE_LENGTH - 1)
            metadata["route_history"][route_key] = ((tail[FEATURES].to_numpy(dtype=np.float32) - mean) / scale).tolist()
            metadata["route_distance"][f"{key[1]}|{key[2]}"] = float(group["Distance"].median())
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf-8")
    report = {key: value for key, value in metadata.items() if key not in {"route_history", "route_distance", "feature_mean", "feature_scale"}}
    report_name = "weather-candidate-evaluation.json" if args.weather_candidate else "latest-evaluation.json"
    (args.output / report_name).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"artifact": str(artifact_dir), "production_ready": metadata["production_ready"], "model_version": MODEL_VERSION, "metrics": metrics}, indent=2))


if __name__ == "__main__":
    main()
