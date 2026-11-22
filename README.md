# SkyScout

SkyScout is a flight search and monitoring application built on the existing React/Vite, Express and MongoDB stack. It searches Google Flights through SerpApi, tracks one-way, round-trip and multi-city itineraries, records fare observations, checks prices in the background and delivers persistent in-app notifications.

See the [deployment runbook](docs/deployment.md) for the independent worker, HTTPS configuration, verification commands and release gates. Dated evidence is preserved under [docs/qa](docs/qa); a previous run's live-provider success does not establish current quota or availability.

The current [production-readiness report](PRODUCTION_READINESS.md) records the 14 November verification, fixes, screenshots and remaining release blockers. Earlier dated reports remain historical evidence.

## Implemented flows

- One-way and round-trip fare search with airport, date, passenger and cabin selections. Round-trip search selects an outbound, then loads return options through SerpApi's departure-token flow.
- Debounced global airport suggestions use a real MIT-licensed 7,884-airport catalog first, consulting SerpApi for unresolved queries. City names, IATA codes and aliases such as Bombay/Bengaluru are supported. Provider failures are distinguished from genuine no matches; the provider key remains on the API server.
- A Results header Dashboard button uses the existing protected route, preserves tracked itinerary context and restores recent results/filters on browser Back without repeating the search.
- Multi-city search supports two to four connected airport/date legs and progressively loads each next leg through the same short-lived server-side token flow.
- Normalized airline segments, schedule, stops, fare extensions and emissions when returned by SerpApi.
- Registration, login and logout with scrypt password hashing and opaque HttpOnly MongoDB sessions.
- User-owned tracked flights with target price, pause/resume, queued manual fare checks and delete. Tracking references bind the saved fare and itinerary to a short-lived server-side search result snapshot instead of trusting browser-supplied route or price fields. Initial flight/observation writes, market price alerts and related-record deletion use MongoDB transactions.
- A MongoDB-backed monitoring worker with provider and return-option caching, shared per-IP request throttling, a six-hour schedule, lease-based concurrency control, exponential retry and conservative itinerary matching.
- Persistent price observations and deduplicated price-drop, target-reached, unresolved-check and supported disruption-risk-change notifications. Scheduled fare checks also refresh eligible disruption estimates without depending on an open dashboard.
- Per-user price-history endpoint and charts in the dashboard.
- Fare Intelligence combines real observations, comparable live offers, sourced calendar context and separately grounded research. Its Day 0â€“14 conditional scenarios show the formula, coefficients and provenance; they do not claim validated fare prediction accuracy. See [Fare Intelligence](docs/fare-intelligence.md).
- Live worldwide METAR/TAF route weather using AviationWeather.gov's daily station directory, including decoded visibility, wind, temperature, conditions and flight category when reported. The dashboard checks each minute while visible and supports manual refresh; the API caches METAR for one minute and TAF for ten minutes in MongoDB, with short leases that share concurrent requests across API processes. Observation time and source-refresh delays are shown explicitly.
- Optional, separately trained LSTM arrival-delay estimate service. The local validated `delay-lstm-v2` artifact covers represented U.S. domestic nonstop airline/airport routes. The service reports unavailable for missing artifacts or unsupported regions, and evaluates the first selected leg for round-trip or multi-city journeys.
- Destination Intelligence resolves the selected arrival airport and final destination, obtains road alternatives from Google Maps Routes when configured, and presents independently sourced news and grounded access research. A routing-provider failure preserves independent airport/news information. It is separate from fare monitoring and the delay model. See [Destination Intelligence](docs/destination-intelligence.md).
- The dashboard has persistent light and dark modes. The preference is stored in the browser and applied before React loads.
- The responsive landing page includes locally stored generated aircraft artwork and locally served, open-licensed Plus Jakarta Sans. Production uses same-origin API requests by default, with no external font dependency. Asset provenance and the exact image-generation prompt are recorded in [the asset notes](docs/hero-asset.md).
- Indian domestic flights are identified separately from the US delay model. The existing delay card can show dated, official airline-level Indian OTP as aggregate context, but no Indian flight probability is served until a genuine flight-level Indian LSTM artifact passes validation. See [Indian delay-model data integrity](docs/india-delay-model.md).

## Known limitations

- Booking options are available only when the provider supplies a booking token; opaque booking references expire after one hour and are shared through MongoDB when connected.
- The current delay model uses U.S. DOT BTS domestic flight history. It does not cover global routes, cancellations, current weather or news. Its historical U.S. evaluation does not establish Indian flight-delay validity or fare accuracy. The artifact is not retrained during startup or CI; see [model provenance](ml/README.md).
- Destination Intelligence is based on recent selected headlines, not complete local reporting or guaranteed ongoing incidents. One news report alone is excluded unless the link is from a recognized official authority. It does not make a personal-safety determination.
- Email notifications are not configured. The notification-provider interface keeps optional delivery failures from suppressing persistent in-app alerts. Weather is informational and is not used as an ML feature.
- MongoDB must be reachable for accounts, tracking, alerts and histories. If it is unavailable, those flows return a service error; flight search can still run.
- Provider search results, airport suggestions, booking options, return options and flight selection references use expiring MongoDB records when connected. Flight search and weather use short MongoDB leases so simultaneous identical requests share one provider result. Other provider response caches can still see simultaneous misses across API processes.
- Complete grounded-report persistence requires an agreement permitting storage and explicit `GEMINI_GROUNDED_STORAGE_AUTHORIZED=true`. The default remains false; provider keys alone do not establish storage permission. National holiday coverage is India 2026 and U.S. 2026â€“27, with no claim of complete regional/school calendars.
- Container configuration is provided; an actual production deployment, host-specific TLS/ingress, image build/scan and post-deployment smoke checks are separate release gates.

## Architecture

```text
React + Vite -> Express API -> SerpApi Google Flights / Google News
                    |  \
                    |   -> Python LSTM inference service (optional)
                    -> MongoDB <- scheduled monitoring worker
```

SerpApi response parsing is isolated in `backend/services/flightServices.js`. Provider tokens and API credentials stay on the server. The monitoring worker is separate from request handling and never trains the ML model.

## Setup

Use Node 24 and Python 3.14.6 for the existing lockfiles and pinned ML dependencies. Work from the inner `SkyScout` app folder (the repository's GitHub workflow is one level above it). Create `.env` from `.env.example` and `backend/.env` from `backend/.env.example` only when missing; preserve existing credentials. Configure the values below and install the locked JavaScript dependencies:

```bash
npm ci
npm ci --prefix backend
npm run dev
```

Run the backend in another terminal:

```bash
cd backend
npm run dev
```

Open `http://127.0.0.1:5173`; keep the API URL and allowed browser origin on the same chosen host name for session cookies. The API defaults to port 5000. MongoDB must support transactions: use a replica set or sharded deployment rather than a standalone process.

For independent local monitoring, set `MONITORING_ENABLED=false` in `backend/.env` and run a third terminal:

```bash
cd backend
npm run worker
```

The worker polls due records each minute and schedules successful comparable-fare checks about six hours apart. Development may instead use the embedded worker; production HTTP replicas must disable it and run a durable independent worker. `npm run worker:once` processes one bounded tick for an external scheduler.

**Check fare** queues an active, upcoming itinerary for the independent worker. It does not change the displayed fare before a verified response. Manual requests are limited to four per user per hour; paused flights must be resumed. The dashboard refresh control reloads saved data.

Install the separate inference environment once, then start it from `ml`:

```bash
cd ml
python -m venv .venv
# Activate .venv: Windows PowerShell .\.venv\Scripts\Activate.ps1
# POSIX: . .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

Place an already evaluated matching model/metadata pair under `ml/artifacts`, or set `SKYSCOUT_MODEL_DIR` in the ML service environment. Artifacts and raw training records are intentionally ignored by Git. With no artifact, `/health` stays live while `/readyz` and supported predictions return 503; the rest of SkyScout remains usable. No training command is part of ordinary setup.

An optional inference container is available with `docker compose -f compose.yaml -f compose.ml.yaml up -d --build`. Its artifact directory is mounted read-only. Set `SKYSCOUT_MODEL_DIR` for a different host directory; the default is `./ml/artifacts`. These image definitions still require an actual Docker build/scan before release.

## Environment variables

| Variable | Needed for | Notes |
| --- | --- | --- |
| `SERPAPI_API_KEY` | Live flight search and Destination Intelligence | Private provider credential; backend only |
| `MONGODB_URI` | Accounts, tracking, observations, alerts and predictions | Use a reachable replica-set or sharded deployment; tracking writes use transactions |
| `PORT` | Backend | Defaults to `5000` |
| `CLIENT_ORIGINS` / `CLIENT_ORIGIN` | Browser/API cookies and CORS | Exact comma-separated allowlist; production requires HTTPS |
| `DNS_SERVERS` | Optional MongoDB DNS override | Comma-separated resolver IPs |
| `ML_SERVICE_URL` | Delay inference | Defaults to `http://127.0.0.1:8001` |
| `SKYSCOUT_MODEL_DIR` | ML service only | Optional path to evaluated weights and matching metadata; defaults to `ml/artifacts` |
| `VITE_API_URL` | Frontend API address | Defaults to `http://127.0.0.1:5000/api` |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Grounded fare and journey research | Private; bounded shared daily request budget |
| `GOOGLE_MAPS_API_KEY` | Actual road routes | Requires Routes API and billing; backend only |
| `GEMINI_GROUNDED_STORAGE_AUTHORIZED` | Complete research-report persistence | Defaults to false; requires a permitted storage agreement |
| `MONITORING_ENABLED` | Embedded development worker | Set false in production API replicas; run `npm run worker` in backend |
| `SERPAPI_MAX_DAILY_REQUESTS` | Optional shared provider spend cap | Configure from the actual provider plan |
| `OPERATIONS_TOKEN` | Private operational diagnostics | Backend only; do not put in the web bundle |

Local `.env` files are ignored by Git. Never add real credentials to source files or Vite `VITE_*` variables.

## API endpoints

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- `GET /health` (API liveness plus database and flight-search configuration status)
- `GET /readyz` (required database readiness), `GET /api/operations` (private bearer token)
- `GET /api/flights/airports?q=...` (provider suggestions plus licensed catalog fallback and source/error metadata)
- `GET /api/flights/search` (one-way, round-trip outbound, or multi-city first-leg options)
- `POST /api/flights/return-options/:departureRef` (short-lived server-held SerpApi departure/next-leg reference)
- `POST /api/flights/booking-options/:bookingRef` (short-lived server-held provider reference)
- `GET /api/tracked-flights`, `POST /api/tracked-flights` (POST requires a current result's `trackRef`; only the target price is taken from client input)
- `PATCH /api/tracked-flights/:id` (target price or active/paused status)
- `GET /api/tracked-flights/:id` (owned selection lookup, including an itinerary outside the current list page)
- `POST /api/tracked-flights/:id/refresh` (queue an active, upcoming fare check)
- `DELETE /api/tracked-flights/:id`
- `GET /api/tracked-flights/:id/history`
- `GET /api/tracked-flights/:id/prediction`
- `GET /api/tracked-flights/:id/weather`
- `GET /api/tracked-flights/:id/destination-intelligence`
- `GET /api/tracked-flights/:id/fare-intelligence`, `/fare-intelligence/market`
- `POST /api/tracked-flights/:id/fare-intelligence/research`
- `GET /api/tracked-flights/notifications`
- `PATCH /api/tracked-flights/notifications/read/:id` and `/read/all`

All tracked-flight, history, prediction and notification operations require a valid session and enforce user ownership in the database query.

Browser mutations, including login and registration, require `X-SkyScout-Request: 1`; the shared frontend client supplies it. Watchlist and inbox responses include stable cursor pagination and account-wide counts.

## ML training and inference

The dataset source, selected BTS fields, target, feature construction, chronological train/calibration/test split, metrics, reproducibility and service commands are documented in [`ml/README.md`](ml/README.md). Raw data and model files stay out of source control. This workspace contains a locally trained 2023â€“2025 BTS baseline; its Julyâ€“December 2025 holdout reached ROC-AUC 0.692 and 8.18% Brier skill over the calibration-prevalence baseline. The inference service exposes predictions only when an evaluated artifact passes its gate, and reports unavailable otherwise.

The [technical defense](docs/technical-defense.md) explains the product contribution, data flow, leakage controls, evaluation and limitations.

## Checks

```bash
npm run lint
npm test
npm run build
```

Backend scripts: `npm run dev`, `npm start`, `npm test` and `npm run test:e2e`. ML commands require the Python 3.14.6 environment described in `ml/README.md`.

## Verification

```bash
# App root: deterministic backend units, request contracts and frontend helpers
npm run lint
npm test
npm run build
npm audit --audit-level=high
npm audit --prefix backend --audit-level=high

# ml, with its virtual environment active: no real weights or paid keys required
python -m pip check
python -m unittest discover -s . -p 'test_*.py'

# backend, against a disposable replica-set database and running API/UI
npm run test:e2e
node scripts/verify-dashboard-navigation.mjs
node scripts/verify-production-browser.mjs
```

The API and dashboard commands create temporary QA accounts/records and clean them up. Dashboard journeys use controlled fare fixtures, real local HTTP sessions and actual MongoDB persistence; fixture success is not proof of fresh SerpApi/Gemini results. The production-browser check serves `dist/` under the nginx CSP on loopback port 5050 and verifies real catalog requests without paid providers. The browser helper accepts `CHROME_PATH`; CI uses installed Linux Chrome. `E2E_API_URL`, `E2E_WEB_URL` and `QA_OUTPUT_DIR` select test services/evidence. `verify-worker-process.mjs` requires the isolated loopback QA database described in the readiness report. Provider-smoke/restoration scripts make separately labeled live requests and consume quota; keep them out of ordinary CI.

The repository workflow runs JavaScript checks, npm audits, isolated replica-set/API/browser integration, Python fixture tests and a Python dependency audit without paid provider keys. This is JavaScript source, so no TypeScript compiler check is claimed. See [deployment.md](docs/deployment.md) for secrets scanning, operational probes and live release smoke checks.

## Fare numbers and model outputs

An observed fare is a timestamped matching provider quote. A future fare scenario is calculated as `round(referenceFare Ã— exp(dailyLogRate Ã— day))`; rupee and percentage changes are derived from that rounded value. The observed-data mode fits daily log changes from earlier quotes for that exact itinerary and requires enough distinct booking days; scenario controls use disclosed illustrative rates. News/calendar adjustments are zero because no measured causal coefficient is installed. These scenarios and their bounds are not validated forecasts or confidence intervals. [Fare Intelligence](docs/fare-intelligence.md) documents the complete method and holdout limitations.

The LSTM is a separate arrival-delay classifier with historical U.S. evaluation. Weather observations, TAF forecasts, sourced events, aggregate Indian OTP and calculated fare scenarios remain separate evidence types.

## Troubleshooting

- If accounts/tracking are unavailable, inspect API `/health` and `/readyz`, database reachability and replica-set support. The configured remote database timed out during verification; local QA success does not fix remote network access.
- Keep browser/API host names consistent in development. In production, verify HTTPS, exact `CLIENT_ORIGINS`, Secure cookies and the actual trusted proxy count.
- Provider timeouts/quotas return explicit errors. When a selected outbound has no onward offers, use the Results recovery control to select another itinerary. No synthetic fares replace missing inventory.
- A queued fare check requires the independent worker. Refreshing the dashboard reloads saved data; it does not create a provider observation.
- Missing Maps credentials produce unavailable routing. Missing/incompatible model artifacts or unsupported regions produce no delay probability. Inspect the private ML `/health` and `/readyz` endpoints.
- Grounded report persistence is disabled unless explicitly authorized/configured. Research cooldowns, rejected findings and unavailable citations do not establish that no travel event exists.

