# SkyScout Viva and Presentation Guide

**Reviewed: 30 October 2026.** This guide accompanies the [project synopsis](SKYSCOUT_PROJECT_SYNOPSIS.md). Implementation boundaries and evidence links appear in the [verification matrix](SKYSCOUT_FEATURE_VERIFICATION.md). Prices in worked examples are illustrative unless explicitly identified as historical test observations.

## A. 60-second introduction

“SkyScout is a flight price monitoring and travel intelligence platform. A user searches real flight offers, selects an itinerary and tracks it through a personal dashboard. A background worker checks the fare periodically, records comparable observations and creates in-app notifications for price drops or target attainment.

“Its main decision-support feature is Fare Intelligence. It displays day-wise lower, central and upper scenarios with rupee changes, percentages and an explanation of the calculation. These are transparent conditional scenarios, not guaranteed future prices. Gemini researches cited events, but it does not choose the price percentages.

“We also integrate aviation weather and a separate LSTM service for supported US domestic arrival-delay estimates. Destination routing is implemented but still requires live credential validation. Our contribution is an integrated, explainable full-stack workflow with persistent monitoring, user ownership and honest data-quality boundaries.”

## B. Three-minute project explanation

“When planning a journey, travellers may check a fare repeatedly and consult separate sources for weather or travel disruptions. We chose this problem because it requires more than a search screen: the application must remember a selected itinerary, obtain comparable later quotes and explain what the available evidence supports.

“SkyScout uses React for the interface, an Express REST API and MongoDB. SerpApi provides flight offers. The backend validates the request and normalizes flight segments, prices and schedules. A selected result receives a short-lived reference. When the user tracks it, the server uses its retained result instead of trusting a fare sent by the browser.

“The monitoring worker is a separate process. It checks for due records every minute and normally rechecks each active flight about every six hours. A database lease prevents another worker from processing the same job simultaneously. Itinerary matching and freshness checks prevent uncertain or old quotes from replacing the latest verified fare. The quote and its qualifying price alerts are committed together.

“Fare Intelligence is separate from this observation history. For eligible one-way flights it calculates future booking-day scenarios up to Day 14, stopping before departure. The default market controls select documented hypothetical rates. The backend calculates the prices, rupee differences and percentages; the frontend renders those same values. An observed-trend mode requires enough real booking days. Neither mode has established general prediction accuracy.

“Gemini with Google Search grounding retrieves possible market and journey developments. The application checks citations, event dates and route relevance. A source-backed event can explain context, but its numerical fare adjustment remains zero without a justified quantitative coefficient.

“The separate Python LSTM estimates arrival delays of at least fifteen minutes for represented US domestic nonstop routes. Its local artifact has an untouched chronological test evaluation. It does not predict airfare, and an Indian model is not installed. Live weather is displayed separately.

“Recorded browser tests verify real search and tracking, fare-chart interaction, sourced cards and failure handling. The current JavaScript suite has 104 passing tests. Live routing, broader calendar coverage, permission-compliant research persistence and production-scale validation remain incomplete. We describe these limits rather than presenting unverified capabilities as finished work.”

## C. End-to-end demonstration explanation

### Before the presentation

- Start the frontend and API, confirm `/readyz`, and run the independent worker if demonstrating automatic monitoring. ML is a separate optional service. Follow [deployment instructions](../deployment.md) for configuration.
- Confirm SerpApi and Gemini access without exposing `.env` contents. Availability is not guaranteed by an old screenshot.
- Choose a **one-way departure at least three weeks after the demonstration date** to support Day 14. Existing search supports other trip types, but their day-wise fare scenarios are unsupported.
- Explain that a fare displayed yesterday is a historical observation, not a new quote today. Use the visible observation timestamp.

| Demo step | What to show and explain | Boundary or fallback explanation |
| --- | --- | --- |
| 1. Open SkyScout | React loads the landing page and search form. | A working page alone does not prove provider connectivity. |
| 2. Register or log in | Express checks credentials and sets an opaque HttpOnly session cookie. | There is no completed email-verification or password-reset flow to demonstrate. |
| 3. Search | Select airport suggestions, a future date, passengers and cabin; submit. | Offers come through SerpApi. Report configuration, quota or timeout errors honestly. |
| 4. Compare and select | Filter or sort results; inspect airline, legs, timing, stops and fare. | An offer is not a completed reservation. |
| 5. Track | Click the tracking control and open the dashboard. | The server persists its retained itinerary and initial price observation. |
| 6. Open Fare Intelligence | Point out the reference fare, timestamp, currency and evidence mode. | One quote supports a hypothetical scenario, not an observed trend. |
| 7. Select Day 1 and Day 4 | Show the selected date, central amount, change, percentage and lower/upper values. Hover and click the graph. | Day numbers are future booking dates, not flight journey segments. |
| 8. Open “Why this estimate?” | Explain the formula, daily rate, coefficient provenance and model version. | The market control is a user-selected assumption, not an automatic diagnosis of market conditions. |
| 9. Inspect events | Automatic research may return cited cards; calendar context appears independently. | A provider failure or zero qualifying events is possible. Do not insert fabricated headlines for the demo. |
| 10. Set a target | Edit the target on the tracked-flight card. | Target attainment is checked against a genuine fare; it is not a promise that the price will fall. |
| 11. Explain alerts | Open the persistent notification inbox and explain price-drop and target rules. | Do not promise a live alert during a short viva. Later real quotes may be unchanged. Controlled alert tests are clearly labeled fixtures. |
| 12. Inspect weather and risk | Distinguish a METAR observation from a TAF forecast and show issue/validity times. | A selected Indian flight has no installed flight-level delay model; use the recorded US inference evidence to explain that separate capability. |
| 13. Enter a final destination | Show the arrival airport and enter a place such as Koramangala for a Bengaluru arrival. | Maps access is missing in recorded evidence. An explicit dependency message is the correct current result, not an ETA. |
| 14. Refresh and sign out | Verify persisted tracking and owner-specific data; logout revokes the session. | An already displayed research report is preserved during failures, but full cross-reload report persistence is permission-gated. |

### What the existing evidence can demonstrate

The recorded DEL–BLR search returned 41 offers and selected an IndiGo fare of ₹10,090 for 26 November 2026. This is a historical QA observation from 29 October India time, not a current offer. One research run rendered three cards supported by grounding metadata. A later run reported Gemini HTTP 503 and a daily budget limit without breaking fare analysis. These are different recorded outcomes and should be presented together.

Live trip checks obtained later genuine observations for round-trip and multi-city itineraries. Their unchanged fares still count as later observations. Notification transaction and deduplication checks used explicitly synthetic test fares; do not describe them as naturally occurring market drops.

## D. Twenty-five likely faculty questions

### 1. How is SkyScout different from Google Flights?

Google Flights already provides comparison, tracking and fare insights. SkyScout’s academic contribution is an inspectable implementation combining a persistent user workflow, reproducible scenarios, cited context and separately scoped delay inference. We do not claim wider coverage, superior forecasting or invention of price alerts. See [Google’s tracking documentation](https://support.google.com/travel/answer/6235879).

### 2. Why did you choose this project?

It connects a practical monitoring problem with meaningful engineering: provider normalization, persistent identity, scheduling, concurrency, authentication and transparent calculations. It also lets us evaluate how an application should communicate insufficient evidence and provider failures.

### 3. Where do flight prices come from?

The backend queries SerpApi’s Google Flights engine and normalizes the returned offers. The browser receives prices, itinerary details and timestamps through our API. Selecting a market scenario does not change the real stored price.

### 4. Does your application own the flight data?

SkyScout obtains external offers and records selected observations for its workflow. It is not the original source of airline inventory and does not claim ownership of provider datasets. Data use, redistribution and storage remain subject to the relevant provider agreements.

### 5. Why does airfare change?

Inventory, booking demand, capacity, promotions and costs can be relevant considerations, but our implementation does not identify every cause of an individual fare movement. We record an observed change separately from a source-backed possible explanation. A headline alone does not establish causation.

### 6. How do you calculate Day 3 or Day 4 estimates?

The backend uses `round(P0 × exp(k × d))`, with a minimum output of one currency unit. In assumption mode, `k = ln(1 + dailyAssumption)`. Observed mode derives bounded log changes from adequate genuine history. These are conditional scenarios, not exact future-price predictions.

### 7. How are percentage changes calculated?

First compute the rounded central price. Subtract the reference fare, divide that difference by the reference fare and multiply by 100, rounded to two decimal places. The frontend displays this server result, which keeps the percentage consistent with the displayed amount.

### 8. How are model coefficients determined?

Default fare-scenario coefficients are explicitly configured hypothetical assumptions. Observed-mode rates come from the itinerary’s earlier daily observations. The separate delay model’s weights are fitted during offline LSTM training. These three coefficient sources must not be confused.

### 9. How do you validate fare predictions?

The repository implements expanding chronological evaluation: estimate using earlier observations, then compare with a later actual quote and a last-price baseline. It reports MAE and MAPE, but small samples are marked insufficient. Current evidence does not establish general fare forecasting accuracy.

### 10. What exactly does Gemini do?

It uses Google Search grounding to research potentially relevant operations, economic developments, events and disruptions. Application code extracts supported citations and validates dates and relevance. DIRECT, RELATED and CONTEXT describe the relationship to the itinerary, not a percentage probability of a fare change.

### 11. Does Gemini directly predict prices?

No. Deterministic server code controls numerical scenarios. The current numerical news/event adjustment is zero. Gemini supplies qualitative context and citations; it cannot overwrite fare values or invent trained coefficients.

### 12. Why do you use an LSTM?

The delay component processes chronological flight-feature sequences. An LSTM maintains a learned state across those steps, making it a reasonable sequence-model choice. The repository records a useful but limited held-out result; it does not demonstrate that LSTM is superior to all simpler classifiers.

### 13. What dataset was used?

The active delay artifact uses US DOT BTS Reporting Carrier On-Time Performance data from January 2023 to December 2025. Metadata records 20,588,132 eligible flights. Training uses bounded samples of route sequences rather than fitting on every possible sequence. This dataset is for delays, not ticket prices.

### 14. Can your LSTM predict delays for Indian flights?

No validated Indian flight-level artifact is installed. A preparation path exists, but legitimate training data and a separately evaluated artifact are still required. Airline-level Indian OTP context, where available, is an aggregate statistic and not the selected flight’s delay probability.

### 15. Why do you use MongoDB?

It stores user accounts, sessions, itineraries, observations, notifications and provider state as related documents. Indexes enforce unique tracking identities and alert keys. Transactions keep related fare and alert writes consistent. The design requires a replica set or sharded deployment for those transactions.

### 16. What happens when an API fails?

Timeouts, bounded retries and categorized errors prevent indefinite waiting. Existing quotes retain their observation timestamps. Independent dashboard sections remain available when optional research, weather or ML fails. Quota exhaustion is reported as a failure status rather than “no news”.

### 17. How does automatic price tracking work?

A long-running worker checks due records approximately every minute, claims an owner-specific lease and requests a fresh comparable offer. It checks itinerary identity and quote time before committing an observation. A normal successful check schedules the next one about six hours later. Production needs an always-on worker or external scheduler.

### 18. How are duplicate alerts avoided?

Notifications have unique deduplication keys and are inserted idempotently. Price-drop keys include quote identity; target keys include the flight and target amount. The monitored quote and qualifying in-app price alerts share a transaction. Lease fencing prevents an old worker from committing after ownership changes.

### 19. How does Destination Intelligence work?

The arrival airport resolves to a city and location. City-level reports come from SerpApi Google News. Entering a final destination invokes separate Routes API and grounded journey-research paths. Live routing is unverified without Maps credentials, and named-road overlap supports only a possible impact, not a confirmed closure.

### 20. Can this platform scale to multiple users?

Owner-scoped records, pagination, shared provider state, leases and quota controls support a multi-user design. They do not prove a specific throughput or availability level. Sustained load tests, provider budgets and production capacity measurements are still needed.

### 21. How do you protect API keys?

Provider credentials remain in backend configuration and are excluded from the frontend bundle. Logs use safe error categories. Authentication uses salted scrypt password hashes, hashed session tokens in MongoDB and HttpOnly cookies. Origin checks and the mutation header add CSRF protection; none of these replaces ongoing security review.

### 22. Why use React and Express?

They are the project’s existing stack. React manages interactive forms, controls and charts; Express exposes JSON endpoints and integrates provider and database operations. JavaScript modules share calculation-related contracts without introducing another frontend framework. ML remains in Python because the existing model uses PyTorch.

### 23. What are the major limitations?

Provider availability, limited genuine fare history, one-way scenario scope, incomplete calendars, unverified live routing and permission-gated report persistence are current limits. The delay model is historical and US-specific. Production load and long-duration operation are unmeasured. Training uses whole departure hours while inference includes minutes; this mismatch needs alignment and re-evaluation.

### 24. Which features are fully implemented?

Evidence supports flight search, authentication, tracking, price history, fare-scenario interaction, in-app alert logic, scoped grounded research and tested weather retrieval. US inference has an installed evaluated artifact and recorded service checks, with stated preprocessing and domain limits. Routing, broader calendar coverage and full production validation are incomplete. Cite the verification matrix rather than saying “everything is complete”.

### 25. What is the actual contribution of your team?

The repository’s contribution is connecting provider results to a user-owned, persistent monitoring and explanation workflow: itinerary matching, transactions, scheduling, scenario calculations, citation checks, UI integration and tests. The team did not create airline inventory, Google Search or Gemini. Individual work allocation should be described from the team’s actual records.

## E. Important formulas and worked examples

### Fare scenarios

Let `P0` be the verified reference fare, `d` the future booking day, and `a` a selected daily assumption. For each lower/central/upper series:

```text
k = ln(1 + a)
P(d) = max(1, round(P0 × exp(k × d)))
Delta(d) = Pcentral(d) − P0
DeltaPercent(d) = round(100 × Delta(d) / P0, 2)
Maximum day = min(14, daysUntilDeparture − 1)
```

The following **illustrative arithmetic** uses ₹10,000, a valid one-way flight more than 14 days away, and the normal-market assumptions. It is not an observed future-price sequence. Values were checked against `buildDailyFare`.

| Day | Lower: −0.20% daily | Central: +0.10% daily | Upper: +0.40% daily | Central change | Central percentage |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | ₹9,980 | ₹10,010 | ₹10,040 | +₹10 | +0.10% |
| 3 | ₹9,940 | ₹10,030 | ₹10,120 | +₹30 | +0.30% |
| 4 | ₹9,920 | ₹10,040 | ₹10,161 | +₹40 | +0.40% |
| 7 | ₹9,861 | ₹10,070 | ₹10,283 | +₹70 | +0.70% |

For Day 4, `round(10000 × exp(ln(1.001) × 4)) = 10040`. Round the calculated price before deriving its displayed percentage. Lower and upper lines are scenario bounds, not confidence intervals.

| Market control | Lower daily assumption | Central daily assumption | Upper daily assumption |
| --- | ---: | ---: | ---: |
| Normal | −0.20% | +0.10% | +0.40% |
| Upward | +0.10% | +0.45% | +0.80% |
| Downward | −0.80% | −0.45% | −0.10% |

Observed mode first computes `ln(laterFare / earlierFare) / elapsedDays` using the last quote on each booking day. It applies outlier/bounding rules and history thresholds before permitting future points. Repeated quotes within one day do not provide several independent booking days.

### Delay model

```text
Target y = 1 when observed arrival delay >= 15 minutes; otherwise 0
Calibrated probability = sigmoid(slope × LSTM logit + intercept)
```

Cancelled/incomplete records are excluded. Platt slope/intercept and the classification threshold are fitted on the separate calibration period. The recorded ROC-AUC of 0.6921 measures discrimination; it is not 69.21% classification accuracy. Brier score measures squared probability error. The 8.18% Brier skill is relative improvement over the recorded prevalence baseline, not an accuracy increase of 8.18 percentage points.

### Three distinctions to remember

- **Observation:** a provider quote at a recorded time.
- **Fare scenario:** a deterministic conditional calculation from assumptions or adequate earlier observations.
- **Delay estimate:** a probability produced by a separately trained model within its supported historical domain.

## F. What we must not claim

- SkyScout is the first or most accurate flight-search or alert platform.
- Gemini predicts exact prices, or a headline establishes a fixed percentage surcharge.
- A normal/upward/downward dropdown proves actual market conditions.
- Scenario bounds are statistical confidence intervals or guarantee the best booking day.
- One booking day establishes a validated price forecast.
- The LSTM predicts airfare, cancellations or delays for Indian flights.
- Current weather and news are features of the served `delay-lstm-v2` model.
- A local artifact’s `production_ready` flag proves deployment or present-day accuracy.
- The stored ROC-AUC is classification accuracy or an individual flight guarantee.
- A city report or road-name match proves an ongoing road closure or exact journey overlap.
- A Maps link proves a traffic-aware route response was obtained.
- Complete Google-grounded reports currently survive reloads without storage authorization.
- Email delivery, commercial ticket booking, production load capacity or sustained availability were verified.
- Synthetic test fares or recorded screenshots demonstrate a new live price change today.

If challenged on an incomplete feature, state the implemented path, identify the missing validation or dependency, and show the relevant evidence. Do not promise an unsupported capability during the demonstration.
