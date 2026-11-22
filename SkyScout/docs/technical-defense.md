# SkyScout technical defense

## Problem and contribution

Travellers often repeat the same flight search to notice fare changes. A search result alone does not preserve a personal fare history, monitor a selected itinerary, or notify its owner when a meaningful change occurs. SkyScout extends its React flight search with authenticated, user-owned tracking, scheduled fare checks, historical observations, persistent alerts, airport weather reports, and an evaluated flight-delay estimate.

The flight search and comparison layer uses SerpApi's Google Flights engine. SkyScout's contribution is the persistent workflow around a selected result: a server-held flight reference, a MongoDB tracked itinerary and initial observation, scheduled re-matching, price history, deduplicated notifications, and a dashboard showing the owner's stored data. Booking remains with the external provider.

## Architecture and data flow

React calls an Express API. Express keeps the SerpApi credential and provider tokens on the server, normalizes flight results, enforces MongoDB session authentication and resource ownership, and records selected itineraries. The monitoring worker claims due tracked flights through a MongoDB lease, repeats the provider search, accepts a result only when route, date and flight identity match, records changed fares, evaluates alerts, and schedules the next check. Expiring provider references and rate-limit counters are stored in MongoDB when connected so API processes can share them.

For supported flights, Express calls a separate Python inference service. Training is an offline command; the request path only loads and runs an evaluated artifact. If the model is unavailable or a route is outside its coverage, flight search and price monitoring continue and the intelligence panel reports that no estimate is available.

## ML question, target and source

The ML task is to estimate the probability that a scheduled, nonstop U.S. domestic flight arrives at least 15 minutes late. The threshold follows the U.S. DOT BTS `ArrDel15` convention. Cancelled flights and rows without a usable arrival-delay label are excluded. No cancellation probability is shown.

The reproducible source is the U.S. DOT BTS Reporting Carrier On-Time Performance monthly archives. The active `delay-lstm-v2` artifact uses all 36 complete months from January 2023 through December 2025. The combined source has 20,928,579 rows; 20,588,132 remain eligible after the stated exclusions. Those records cover 15 reporting airlines, 362 airports and 15,995 airline-direction routes. The combined CSV SHA-256 is `4e59a4022965492b2e23a9d0d3ee997c6dc52ca3b908d1526d4402070945858f`. The source manifest and artifact metadata record its provenance and split details. Check current BTS terms before redistributing raw records.

## Features and leakage control

Each sequence contains ten scheduled flight steps. Inputs include cyclical scheduled departure hour, weekday and month, scheduled duration, route distance, and historical delay summaries derived from earlier completed days on the same airline route. A flight's own arrival delay and same-day future outcomes are not used as pre-departure inputs. Normalization statistics come from the training period. Bounded, seeded sampling limits memory use while drawing route windows across each chronological split.

The historical BTS export does not contain prediction-time METAR or TAF observations joined to each flight. SkyScout retrieves current METAR and TAF reports from AviationWeather.gov for the dashboard and caches those reports on the backend. **Weather does not enter the active LSTM probability.** The interface labels it separately. News headlines are not model inputs. [NOAA's GHCNh hourly archive](https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly) is a potential historical weather source. A weather-enabled model would require mapping its stations to airports, joining only observations available before each departure, checking coverage and leakage, retraining, and a new untouched test evaluation before claiming weather-based probabilities.

## Training and evaluation

The chronological training period ends February 11, 2025; calibration ends July 21, 2025; the untouched test period runs July 22 through December 31, 2025. The run uses 150,000 training windows, 25,000 calibration windows and 25,000 test windows, eight epochs, and seed 2025. The LSTM is trained with class-aware loss; Platt scaling and the classification threshold are fitted on the separate calibration period. The final test period is used once for evaluation. The artifact is served only if test ROC-AUC is at least 0.55 and Brier skill versus the calibration-prevalence baseline is positive.

| Held-out test metric | Result |
| --- | ---: |
| Precision | 0.351 |
| Recall | 0.533 |
| F1 | 0.424 |
| ROC-AUC | 0.692 |
| Brier score | 0.1555 |
| Brier skill versus calibration-prevalence baseline | 8.18% |

The result indicates useful, limited discrimination and probability skill on later U.S. domestic flights. It is not a guarantee for an individual flight. The model has not been validated on international routes, connecting itineraries, cancellations, or flights after the test period. The UI therefore restricts estimates to represented nonstop U.S. routes and displays the model version, generation time, historical scope and evaluation period.

## Reproduction and inspection

Use the Python version and pinned dependencies in [the ML README](../ml/README.md). Download the monthly BTS archives with `ml/download_bts.py`, train with `ml/train.py` and the recorded seed/limits, then inspect `ml/artifacts/latest-evaluation.json` and `ml/artifacts/metadata.json`. The inference service's `GET /health` confirms whether the evaluated artifact loaded; `POST /predict` returns a probability only for supported input. The backend stores predictions with model version and timestamp, and refreshes a recent prediction when the serving version changes.

The repository's Local QA/readiness artifact omitted from public source repository. records which user flows were verified against MongoDB and SerpApi, and which deployment risks remain. Flight search deduplicates simultaneous identical misses with a short MongoDB lease; other provider reads can still duplicate on simultaneous misses. A global weather-enabled delay model has not been trained.
