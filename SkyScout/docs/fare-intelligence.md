# Fare intelligence

The dashboard preserves authentication, watchlists, weather, destination intelligence and delay-model panels. Fare calculations never call or repurpose the BTS delay LSTM.

## Independent evidence flows

- GET /api/tracked-flights/:id/fare-intelligence?mode=observed|assumption&market=normal|upward|downward returns the baseline, real history, daily calculations, chronological evaluation, calendar and research status. Ownership is checked server-side.
- GET /api/tracked-flights/:id/fare-intelligence/market searches SerpApi for the same route/date/cabin/passengers/currency. Only a matched itinerary becomes a PriceObservation. Alternative offers remain comparison data.
- POST /api/tracked-flights/:id/fare-intelligence/research runs automatically when the card mounts; manual refresh is available. Price and market requests do not wait for Gemini. Selector changes and React rerenders do not initiate research.
- Provider quote timestamps and stable quote keys prevent cached search results from becoming additional observations. Shared flight searches have a five-minute cache. Monitoring requests fresh provider results; quotes older than five minutes cannot change tracked fares or create price alerts. Earlier real market offers remain visible with a stale label on provider failure.

## Deterministic daily calculations

Day 0 is the last observed fare. Future dates stop strictly before departure and at Day 14. One-way totals are supported; round-trip/multi-city totals are not split into invented leg fares.

Observed Day d requires at least max(7, d + 3) booking days and 2 * d days of history, except Day 1, which requires three booking days across two days. Multiple intraday quotes do not count as separate booking days. The last quote of each booking day is used. Booking days use the origin airport's IANA timezone, with a disclosed UTC fallback for unresolved airports.

Observed log changes are ln(later / earlier) / elapsedDays. The central rate is the median, lower/upper rates use the 20th/80th percentiles and include unchanged fare as a boundary. Outlier handling and an 8% daily-equivalent cap are defined in fareBaseline.js.

```text
scenario = max(1, round(observedFare * exp(dailyLogRate * day)))
centralChange = centralScenario - observedFare
percentChange = round(centralChange / observedFare * 100, 2)
eventAdjustment = 0
```

The default conditional-scenario view uses explicitly illustrative daily simple rates; the observed-data view remains selectable:

| Market assumption | Lower | Central | Upper |
| --- | ---: | ---: | ---: |
| Normal | -0.20% | +0.10% | +0.40% |
| Upward | +0.10% | +0.45% | +0.80% |
| Downward | -0.80% | -0.45% | -0.10% |

The backend converts these with log1p(rate) before applying the same formula. They are assumptions, not learned predictions or news sentiment. Bounds are not confidence intervals. News never changes the rates or adds an invented surcharge. The selected-day panel and tooltip display backend output and inputs.

## Evaluation

backtestFare uses expanding chronological holdouts: a target quote never enters its own estimation history. It compares central estimates against actual later quotes and a last-price baseline, returning sample count, MAE, MAPE and individual evaluations. Fewer than 20 holdouts are marked insufficient evaluation. Short histories do not establish general accuracy; performance must be assessed against the last-price baseline on genuine later observations.

## Grounded research

Research covers airline/airport operations, sales/capacity, economic/fuel developments, holidays/events, weather and access disruptions. It uses Gemini generateContent with Google Search; no Interactions API is used.

The request asks for source-cited labeled prose because an actual JSON-only response returned queries and suggestions but no source chunks/supports. The parser supports labeled records and legacy JSON. Labeled record citations must overlap the record; only actual supported grounding chunks become links. Unsupported sources, missing dates, duplicates and irrelevant periods have separate rejection counts.

Findings are ranked DIRECT, RELATED or CONTEXT. Recent national/industry economic context may be retained without city mentions when its scope fits the route. Context never establishes a route-specific fare effect. Raw Markdown is stripped from display fields. Provider source URLs and Search Suggestions accompany the cards.

At most 18 grounded calls per UTC day are shared across fare and destination research. Research throttles are per authenticated user, avoiding collisions between users behind one IP. Provider failure status has a five-minute retry cache. Successful fare checks claim a configurable cooldown.

## Persistence and provider terms

IntelligenceReport stores the complete normalized report, itinerary identity, sources, timestamps, expiry and last attempt only when GEMINI_GROUNDED_STORAGE_AUTHORIZED=true. The stable key includes owner, flight, itinerary, cabin, passenger counts and currency. Fresh authorized reports avoid new calls; failed refreshes retain the prior report and its original timestamp. The MongoDB storage path is exercised with an explicitly synthetic report.

The flag defaults to false because the [Google grounding terms](https://ai.google.dev/gemini-api/terms) restrict caching Grounded Results and Search Suggestions. An API key does not establish storage permission. Cross-reload persistence of complete Google-grounded reports remains gated on a permitted storage agreement. Authorized records expire after seven days. Already displayed reports survive failed refreshes within the current page. Prices, calendars and market comparisons remain independent.

## Calendar and destination

India 2026 uses the accessible official [NHAI holiday list](https://nhai.gov.in/assets/pdf/List_of_holidays-2026.pdf). Diwali on November 8 is corroborated by [India Post](https://www.indiapost.gov.in/holidays-list). U.S. coverage uses OPM holidays for 2026-27. Complete regional or school calendar coverage is not claimed; separately grounded dated findings can supplement national dates.

Destination routing uses the outbound arrival for round-trips and the final leg's arrival for multi-city journeys, together with the entered destination. Google Maps Routes API supplies real routes, distance, durations and steps when configured. Airport wall times are resolved using their IANA timezone. Missing credentials and API/billing rejection statuses are explicit. Road-name matches indicate possible overlap only: without verified event coordinates, geometry and travel-time overlap remain unverified. City reports and journey providers fail independently.

## Verification

```powershell
# App root
node --test --test-isolation=none backend/config/*.test.js backend/services/*.test.js backend/middleware/*.test.js src/utils/fareScenario.test.js
npm run lint
npm run build -- --configLoader native

# backend, with the UI/API running
node scripts/verify-fare-repair.mjs
```

The browser script creates a temporary account with actual SerpApi offers, captures screenshots and cleans up its account. Inspecting other users' historical series requires explicitly setting QA_INCLUDE_EXISTING_HISTORY=true. Separate browser-only event/failure fixtures are labeled. The synthetic persistence test is isolated and cleaned up. Deployment-specific QA output is kept in local, ignored directories and is not published with the source.

Database resilience: socket DNS lookup now has a resolve4 fallback and a five-minute cache of successfully resolved addresses. DNS_SERVERS applies to resolve queries; setServers alone does not control the OS getaddrinfo socket lookup. Network outages still remain real availability failures.
