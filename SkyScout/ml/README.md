# SkyScout delay model

This is an offline training pipeline and a prediction-only service. Training never runs during a user request. If the trained artifact is absent, the inference service returns unavailable and SkyScout displays no probability.

## Dataset and prediction target

Use the US DOT BTS **Reporting Carrier On-Time Performance** monthly export. BTS publishes individual domestic flight records, including schedule, carrier, origin/destination, elapsed time, arrival delay and cancellation status. The downloader fetches completed monthly archives from the [official BTS archive](https://transtats.bts.gov/PREZIP/), validates the ZIPs, and combines only `FlightDate`, `Reporting_Airline`, `Origin`, `Dest`, `CRSDepTime`, `CRSElapsedTime`, `Distance`, `ArrDelay` and `Cancelled`. The trainer also accepts a single CSV or a BTS ZIP containing exactly one CSV.

The monthly BTS README documents the source, reporting period and field definitions; it does not include a separate data license. Keep the dataset provenance and date range with each model artifact, and confirm current BTS terms before redistributing raw records. The current model uses the U.S. domestic records only; it does not imply global airline or route coverage.

The label is **arrival delay of at least 15 minutes**, matching BTS's `ArrDel15` definition (`ArrDelay >= 15`). Cancelled flights and rows without an arrival delay are excluded. Because BTS is US domestic data and this first model trains on nonstop route sequences, predictions are returned only for airline/airport routes represented in the training data and only for nonstop flights. It does not claim global coverage or use current weather/news; the historical on-time export does not include prediction-time METAR/TAF observations joined to each flight.

## Reproducible training

Use Python 3.14.6 (see `.python-version`). The pinned PyTorch, NumPy and pandas releases provide CPython 3.14 Windows wheels:

```bash
cd ml
python -m venv .venv
# Activate .venv for your shell, then:
python -m pip install -r requirements.txt
python download_bts.py --start 2023-01 --end 2024-12 --output data/bts-on-time-2023-2024.csv
python train.py data/bts-on-time-2023-2024.csv --output artifacts --epochs 8 --seed 2025
```

The downloader caches monthly ZIPs under `ml/data`, reuses previously downloaded valid archives, resumes timed-out HTTP range transfers with bounded backoff, writes the combined CSV atomically, and records its row count and SHA-256 in a neighboring manifest. Choose completed months only. BTS may not have published the most recent month yet; if a requested archive is unavailable, use an earlier end month. Plan for several hundred megabytes of downloads per year and additional disk space for the combined CSV. Training will still refuse to produce an artifact when chronological train/calibration/test windows are too small.

`train.py` validates required columns, removes cancelled/incomplete rows, orders route sequences by date and scheduled departure time, and builds route-delay history from completed prior days only. No same-day arrival-delay result is used as a pre-departure feature. It creates ten-flight chronological sequences, and makes 70% train / 15% probability-calibration / 15% final-test time splits. Feature statistics are accumulated in bounded chunks. It samples route windows across each split with a seeded reservoir so the caps do not select only the first airline/route groups. It writes a model plus `metadata.json` with dataset SHA-256, date range, airline/airport/route coverage, label counts, feature definitions, package versions, parameters, precision, recall, F1, confusion matrix, ROC-AUC, Brier score, Brier skill versus a calibration-prevalence baseline and sample counts. The probability threshold is chosen using the separate calibration period; the newest test period remains untouched for final evaluation.

An artifact is installed in the inference directory only when test ROC-AUC is at least 0.55 and Brier skill is positive. A weaker model is saved under `artifacts/candidate` with its evaluation report and remains unavailable to users; no probability is served from a failed evaluation.

## Current local baseline

The ignored local `delay-lstm-v2` artifact was trained from 36 complete BTS months spanning 2023-2025: 20,928,579 source rows and 20,588,132 eligible flights after cancelled/incomplete rows were removed. It covers 15 reporting airlines, 362 airports and 15,995 airline-direction routes. The target rate among eligible flights is 21.23%. The 70/15/15 chronological split uses data through February 11, 2025 for training, through July 21 for calibration, and July 22-December 31 for the untouched test period. The bounded, seeded samples contain 150,000 training, 25,000 calibration and 25,000 test windows.

| Test metric | Result |
| --- | ---: |
| Precision | 0.351 |
| Recall | 0.533 |
| F1 | 0.424 |
| ROC-AUC | 0.692 |
| Brier score | 0.1555 |
| Brier skill vs. calibration-prevalence baseline | 8.18% |

This baseline shows useful but still limited signal beyond the prevalence baseline. Treat its probabilities as estimates with U.S. domestic historical scope; it has not been validated on non-U.S. flights. The exact dataset digest, split counts, threshold, confusion matrix and package versions are stored in `artifacts/latest-evaluation.json` and the model metadata.

Run the calibration and evaluation-metric unit checks with `python -m unittest discover -s . -p "test_*.py"`. They check the numeric helpers only; they do not train a model or replace evaluation on real BTS records.

Metrics reported on the final chronological test period include precision, recall, F1, ROC-AUC and Brier score. Platt scaling is fit on the separate calibration period. Metrics are not known until the pipeline is run against an actual dataset; no values are prefilled.

## Historical weather research pipeline

The production `delay-lstm-v2` artifact above remains a schedule/history model. A separate research pipeline now prepares pre-departure weather features without changing served predictions. NOAA's [GHCNh product](https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly) supplies hourly station observations. `audit_weather_stations.py` maps BTS origin airports to stations using exact ICAO plus a distance check, with a nearby-station fallback for four changed/missing ICAO identifiers. The airport metadata comes from the MIT-licensed [airportsdata catalog](https://github.com/mborsetti/airportsdata). Local source files, downloaded station-year partitions and manifests stay under ignored `ml/data/`.

Use `download_historical_weather.py --iata JFK,LAX --start-year 2023 --end-year 2025` to download a sample. The downloader resumes partial HTTP transfers, checks source fields and byte counts, and writes compact per-station CSV partitions with source URLs, dates and SHA-256 hashes. `join_historical_weather.py` converts scheduled departure times from the airport's local timezone to UTC and uses the most recent observation at or before scheduled departure, at most two hours old. Ambiguous or nonexistent local times are excluded. Missing precipitation is kept missing, not treated as zero. [NOAA's GHCNh definitions](https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/doc/ghcnh_DOCUMENTATION.pdf) give temperature in Celsius, wind speed in metres per second, visibility in kilometres, ceiling height in metres above ground, and precipitation in millimetres (nominally hourly).

The JFK 2023 pilot retained 129,620 eligible scheduled departures; 129,606 had a recent preceding observation. That is one airport-year and does not establish model benefit. `build_weather_training_data.py` performs a single-pass join for selected airports; its candidate features use observations available at least 45 minutes before scheduled departure and no older than two hours. A JFK/LAX 2023 pilot produced 321,878 valid scheduled departures, of which 321,774 had a recent observation by that cutoff. Any weather-aware candidate must be evaluated against a schedule/history baseline on exactly the same flights and chronological splits, with missing-value indicators and a near-departure inference path that can actually obtain recent weather. Until then, SkyScout correctly describes live weather as context rather than a feature used by the served model.

The pilot trained the unchanged 10-feature LSTM and an experimental 21-feature LSTM on the same JFK/LAX rows, date cuts and sampled windows (5,000 training, 1,000 calibration, 1,000 test; two epochs). Test ROC-AUC was 0.566 versus 0.595 and Brier score was 0.14183 versus 0.14132, respectively. The candidate is kept under `artifacts/weather-pilot-candidate/candidate`, marked `production_ready: false`, and has no inference integration. Those small-sample results are evidence to continue the larger study, not a production quality claim.

The larger local study downloaded all 60 station-year partitions for the 20 busiest BTS origins in 2023-2025. The single-pass join produced 10,704,553 valid scheduled departures; 10,661,807 had weather observed 45-120 minutes before departure. Temperature, wind and visibility were present for about 99.5% of rows, ceiling for 81.0%, and precipitation for 62.0%. Missing values remain missing in the source and are represented with explicit presence indicators in the candidate's 21 model features.

| Same 20,000-window chronological test | Schedule/history LSTM | Weather candidate LSTM |
| --- | ---: | ---: |
| ROC-AUC | 0.6781 | 0.6947 |
| Brier score (lower is better) | 0.16552 | 0.16129 |
| Precision | 0.3449 | 0.3861 |
| Recall | 0.5807 | 0.5289 |
| F1 | 0.4328 | 0.4463 |

Both models used the same 100,000 training, 20,000 calibration and 20,000 test route windows, six epochs, and chronological cuts (train through 2025-02-09; calibration through 2025-07-21; test after). Reports and digests are in ignored `artifacts/weather-top20-baseline/latest-evaluation.json` and `artifacts/weather-top20-candidate/weather-candidate-evaluation.json`. The weather candidate is deliberately not served: it applies only to near-departure predictions when a suitably timed observation exists, while the current inference API does not yet supply weather features or candidate route history. The deployed `delay-lstm-v2` remains the full domestic baseline above.

## Run inference

With the same virtual environment and the trained artifact present:

```bash
cd ml
uvicorn app:app --host 127.0.0.1 --port 8001
```

Set `ML_SERVICE_URL=http://127.0.0.1:8001` for the backend. The service loads the artifact once at startup; it exposes `GET /health`, `GET /readyz` and `POST /predict`. `/health` is liveness; `/readyz` returns 503 when no evaluated regional artifact is installed. It does not expose a training endpoint. The backend persists supported predictions with model version and generation time, rejects invalid numerical responses, and returns an unavailable response when the model service or route coverage is missing.

Inference uses the same ten ordered features and whole scheduled local hours as the existing trainer, including its original duration/distance clipping. Offset-bearing departure times are converted to the origin airport's IANA timezone; provider wall times are treated as airport-local. Normalized route history supplies the prior-delay features; the current normalized record completes a ten-flight sequence, with left padding for short histories. The service validates feature order, scales, route-history dimensions, calibration and evaluation metadata before accepting weights. These correctness checks do not update old route histories or establish improved real-world accuracy.

Keep `backend/data/destination-airports.json`, `destination-airport-overrides.json` and `airport-locations.json` at their existing relative paths when packaging the ML service. Set `SKYSCOUT_MODEL_DIR` if weights are mounted elsewhere. Raw data and artifacts are intentionally absent from a clean checkout. `python -m unittest discover -s . -p "test_*.py"` runs deterministic inference/HTTP and data-pipeline fixtures without downloading data or requiring installed production weights. `python check_regional_inference.py` separately smoke-checks the actual installed model using a synthetic supported schedule. It is not a live-flight evaluation.
