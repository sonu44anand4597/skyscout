# Deploying the existing SkyScout application

This repository provides API, independent worker, static-web and optional ML
container definitions. Run image builds, image scans and host-specific smoke
checks in the deployment environment before release. Local QA output is not
included in the public source repository.

The app requires a reachable MongoDB replica set or sharded cluster. Confirm
outbound DNS/TLS access and the Atlas access list from the deployment host; do
not open unrestricted database access for production.

For containerized inference, use:

```sh
docker compose -f compose.yaml -f compose.ml.yaml config
docker compose -f compose.yaml -f compose.ml.yaml build
docker compose -f compose.yaml -f compose.ml.yaml up -d
```

The ML overlay points API/worker requests at the private `ml:8001` service and
mounts evaluated artifacts read-only from `${SKYSCOUT_MODEL_DIR:-./ml/artifacts}`.
The ML build context is the app root because inference uses the shared airport
timezone catalog. No checkpoint or training data is baked into the image. Missing
artifacts keep `/readyz` unavailable. Retain one supervised inference process per
allocated model-memory budget; no unmeasured throughput claim is made.

## Required services and configuration

- Node 24; use `npm ci` in both the app and `backend` directories.
- A reachable MongoDB replica set or sharded cluster. Tracking, quote commits,
  notification persistence and deletion use transactions. A standalone MongoDB
  process does not satisfy this requirement.
- Private SerpApi and Gemini credentials. Set provider budgets to your actual
  plan; this repository does not assert provider prices or entitlements.
- Google Maps Routes API, an enabled billing account and a properly restricted
  server credential for genuine road routes. An API key for legacy Directions
  alone is insufficient. Configure `GOOGLE_MAPS_API_KEY` on the backend.
- HTTPS ingress and exact `CLIENT_ORIGINS`, for example
  `https://your-actual-host.example`. Production startup rejects HTTP origins.
- `SESSION_SAME_SITE=Lax` for the same-site web/API deployment. If intentionally
  deploying across sites, use `None` with production Secure cookies and retain
  the exact CORS allowlist and CSRF header. Host-only HttpOnly cookies are used.
- Set `TRUST_PROXY` to the actual trusted hop count, and prevent direct public
  access to API replicas. The provided nginx proxy overwrites forwarded IP
  headers; adapt trusted-ingress address handling to the real host topology.
- Set `MONITORING_ENABLED=false` in HTTP replicas. Run `npm run worker` in an
  always-on process managed by Docker, systemd or the chosen host's worker role.
  It rechecks due records approximately every six hours and recovers expired
  leases after restart. Do not run this timer in a sleeping serverless service.

For an external scheduler, run `cd backend && npm run worker:once` once per
minute. Each invocation takes at most four due jobs; provision enough invocations
or worker instances for the actual backlog. Concurrent instances claim exclusive,
owner-fenced database leases. Permanent query/configuration errors or six
consecutive failures stop a track in `unresolved` until reviewed and resumed.

The ML service is optional and independent. Install `ml/requirements.txt` in its
own Python environment and mount the existing validated BTS weights and metadata
read-only. Start `uvicorn app:app --host 0.0.0.0 --port 8001` inside its private
service network and set `ML_SERVICE_URL` on the backend. Do not expose it publicly.
No Indian flight-level model is installed; unsupported-domain results remain
explicit. Model training is never run during API/worker startup.

Use Node 24 and Python 3.14.6 (the version in `ml/.python-version`). The model
service also needs the repository's `backend/data/destination-airports.json`,
`destination-airport-overrides.json` and `airport-locations.json` at their existing
relative paths. They provide region and airport-local timezone resolution.
`SKYSCOUT_MODEL_DIR` may point to a read-only artifact mount; it must contain
`metadata.json` and the matching `delay-lstm-vN.pt`. Missing or invalid artifacts
leave the optional service live but not ready, and do not block the Express API.
Never train a model during an image build or download raw BTS data at startup.

## Host-managed production processes

From the app folder, install and build before changing the running release:

```sh
npm ci
npm ci --prefix backend
VITE_API_URL=/api npm run build
```

The last command uses POSIX environment syntax; in PowerShell set
`$env:VITE_API_URL='/api'` before `npm run build`. Vite substitutes this public URL
at build time; changing the server's environment later does not rewrite a bundle.
Serve `dist/` using a configured static host/reverse proxy with SPA fallback, or
use the provided nginx image. Vite's development server and preview server are
not the production web host. Keep provider keys and database credentials in the
runtime secret store, never a `VITE_*` variable.

Run the following as separate supervised services, with working directories
explicitly configured (`backend` for API/worker, `ml` for inference):

```sh
# backend service environment: NODE_ENV=production, MONITORING_ENABLED=false,
# MONGODB_URI, HTTPS CLIENT_ORIGINS and other required private values
npm start

# independent backend worker, same database/provider secrets
npm run worker

# separate Python environment, with requirements installed beforehand
python -m uvicorn app:app --host 0.0.0.0 --port 8001
```

Use an always-on worker role or an external durable scheduler for
`npm run worker:once`; a browser tab, sleeping web instance or ephemeral scheduled
timer is insufficient. Use a dedicated database/account for automated checks and
deny public network access to MongoDB and ML. Container users must set
`ML_SERVICE_URL` to a reachable private service hostname, not the API container's
`127.0.0.1`. Compose currently defines web/API/worker only; provision optional ML
separately when desired.

## Local container preparation

Configure `backend/.env` with production values, then run from the app directory:

```sh
docker compose build
docker compose up -d
```

The web container binds only `127.0.0.1:8080`; place HTTPS ingress in front of it.
API and worker containers use the existing external MongoDB deployment. The web
bundle uses `/api` and carries no provider secrets. SPA routes fall back to
`index.html`; hashed assets are cached, HTML is revalidated, and API requests
retain their original routes. Pin and review container digests for the actual
release after building and scanning them in the deployment environment.

Both API and worker receive 20 seconds to stop, exceeding their 15-second bounded
shutdown deadline. Give host-managed processes at least that grace period as
well. Do not terminate all worker instances in the middle of a rollout; drain
active work before replacing them and monitor lease recovery. The worker exposes
its heartbeat through the API's private operations endpoint rather than an HTTP
listener. Exactly-once processing is not claimed; lease fencing and unique
observation/notification identities make retry behavior idempotent.

## Verification before release

```sh
npm run lint
npm test
npm run build
cd backend
npm run test:e2e
node scripts/verify-dashboard-navigation.mjs
node scripts/verify-concurrency.mjs
node scripts/verify-model.mjs
node scripts/verify-weather.mjs
node scripts/check-secrets.mjs
node scripts/backfill-quote-timestamps.mjs
```

The Dashboard navigation suite uses explicitly controlled fare fixtures and real
local auth/HTTP/MongoDB calls; it does not consume paid provider keys. Chrome is
required, with `CHROME_PATH` set for non-default installations. Set
`E2E_API_URL`, `E2E_WEB_URL` and `QA_OUTPUT_DIR` when testing a different local
stack or preserving a new evidence directory. Never run QA against real users'
records; the scripts create and remove their own temporary accounts. The
concurrency/model/weather suites require their named local dependencies, and
weather calls use a public provider. Run paid-provider scripts only as a bounded,
separately labeled live smoke check after reviewing current quota.

From `ml` with its virtual environment active, run:

```sh
python -m pip check
python -m compileall -q app.py train.py india_support.py
python -m unittest discover -s . -p 'test_*.py'
python check_regional_inference.py
```

The fixture suite validates preprocessing against the existing trainer, feature
ordering, sequence construction, calibrated outputs, invalid artifacts/requests,
missing-model responses and HTTP contracts. It never retrains or modifies served
weights. The last smoke check requires the separately installed evaluated U.S.
artifact and uses a synthetic schedule; it does not prove a live flight's future
outcome. Python dependency vulnerabilities are checked in CI with `pip-audit`;
`pip check` only verifies package compatibility.

The backfill defaults to a dry run. `--apply` fills a missing quote timestamp
only when the current fare matches the latest actual observation; it changes
no prices and deletes no history. Inspect the dry-run counts before rollout.
Existing records with conflicting price/history data require individual review.

The existing Chrome/CDP browser suite is
`node scripts/verify-fare-repair.mjs`. It uses temporary accounts and real
provider requests; its interception fixtures are labeled separately. Chrome's
path must be adapted on non-Windows hosts. Evidence defaults to
an ignored local QA directory; set `QA_OUTPUT_DIR` to a new run directory to
preserve earlier captures. It does not query other users' histories unless
`QA_INCLUDE_EXISTING_HISTORY=true` is explicitly set.

## Health and operations

`GET /health` is liveness and may report degraded dependency state with HTTP 200.
`GET /readyz` checks required database connectivity and returns 503 when not ready.
Optional Maps/Gemini/ML failures do not take down the rest of the application.
`GET /api/operations` is hidden unless `Authorization: Bearer <OPERATIONS_TOKEN>`
matches the private configured token. It exposes safe provider stage counts,
failure categories, ML health and the durable monitoring heartbeat. Keep this
token out of the browser and health-probe logs. Provider counters are cumulative
while their shared operational record exists; records expire seven days after
their last update. The worker heartbeat and rate-limit rejection counts are also
shared through MongoDB.

Public probes (use the actual deployment origin and private ML hostname):

```sh
curl --fail https://your-skyscout-host.example/health
curl --fail https://your-skyscout-host.example/readyz
# On the private service network only:
curl --fail http://ml-service:8001/health
curl --fail http://ml-service:8001/readyz
```

ML `/health` is a 200 liveness response with installed regional versions; `/readyz`
is 503 when no validated model can serve requests. Express `/readyz` requires
MongoDB rather than every optional provider. Health and configuration status do
not establish SerpApi quota, Gemini grounded findings or route correctness.
Inspect private operations diagnostics through a secure client that injects the
token from its secret store; avoid putting its value in shell history or logs.
The application has structured safe operational logs and persisted provider/worker
diagnostics; no external error-monitoring account or log-alerting destination has
been configured by this repository.

Alert on database readiness loss, missing/old worker heartbeat, growing overdue
tracking backlog, lease contention, provider quota/cooldown, repeated request
failures and HTTP 5xx rates. Decide thresholds from measured traffic and the
monitoring interval; no unmeasured latency/service-level claim is made.

Research uses per-user throttles, short negative caches and exclusive research
leases. The Gemini SDK's implicit retries are disabled; one retry on a transient
503 must pass the shared daily budget again. SerpApi uses bounded retry/backoff,
Retry-After handling, a configured optional daily budget, four provider slots
and short response caches. Quota exhaustion never means "no news".

## External release gates

Complete live Maps routing and geographic/time-overlap checks after configuring
the real Routes credential and billing. Regional/school-event coverage requires
verified source data beyond the installed national calendars. Grounded report
storage remains gated by `GEMINI_GROUNDED_STORAGE_AUTHORIZED`; enable it only under
an agreement permitting that storage. The default Google Search grounding terms
restrict caching ([official terms](https://ai.google.dev/gemini-api/terms)). An API
key is not a storage entitlement. No provider credentials, permissions or billing
were changed during this work.

Also verify the actual host's DNS/TLS, reverse-proxy hop count, Secure cookie
behavior over HTTPS, same-site/cross-site CORS topology, static SPA deep links,
container build/scan and shutdown behavior. Docker/Compose and hosted CI must be
executed in an environment that provides them; checked-in configuration alone
is not evidence that an image was built or a deployment occurred.

Fare numbers are conditional scenarios, not validated predictions. Actual
chronological holdouts are reported where suitable observations exist; neither
synthetic test fixtures nor the US delay model establish Indian fare accuracy.

Post-deployment smoke checks must cover: register/login/logout in a QA account;
Mumbai autocomplete and a bounded future search; Results → Dashboard → Back;
tracking/refresh/removal; a worker tick against a QA tracking record; Fare
Intelligence formula/day controls; unavailable optional providers; owned-record
denial from a second QA account; mobile and light/dark layout. Separate genuine
provider responses from deterministic test fixtures in the release evidence.

## CI and release evidence

`.github/workflows/ci.yml` at the repository root runs:

- Locked JavaScript installs, lint, combined backend/frontend-helper unit checks,
  production bundle and high-severity npm dependency audits.
- An isolated MongoDB 8 replica set, API and Vite; real HTTP/database QA and the
  Dashboard browser fixture journey. No paid API credentials are configured.
- Python 3.14.6 install/compatibility checks, compilation, deterministic unittest
  inference/data-pipeline contracts and a strict Python dependency audit.

The CI replica set is necessary for tracking transactions and is destroyed with
the runner; it does not connect to the developer's MongoDB. Evidence artifacts
retain test screenshots and local service logs. No TypeScript check is configured
because this application is JavaScript. Live-provider quota/authentication,
network-specific routing and actual evaluated model weights are separate smoke
checks, not silently skipped deterministic tests. GitHub execution must be
reviewed after push; a local test result does not establish a hosted-CI pass.

Rollback individual changed source files from the ignored pre-change archive
described in Local QA/readiness artifact omitted from public source repository.. Preserve `.env`, the
existing model artifacts, database records and the user's Git index. Drain active
workers before changing code; shutdown waits for in-progress work, with a bounded
deadline and lease recovery if a host forces termination.
