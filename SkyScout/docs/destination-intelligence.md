# Destination Intelligence

Destination Intelligence turns recent, source-backed reports for a tracked flight's arrival city and airport into a travel briefing. It does not classify any city as safe or assert that a reported incident is still active.

## Final destination journey

The card accepts a final destination, such as Koramangala. `GET /api/tracked-flights/:id/destination-intelligence?finalDestination=Koramangala` uses the selected flight's arrival airport and arrival time. With `GOOGLE_MAPS_API_KEY`, the server asks Google Maps Directions for road routes and alternatives. Without that key, it returns `routing.status: "not_configured"` and names the missing setting. It never invents a route or duration.

The server asks Gemini 2.5 Flash with Google Search grounding about potentially relevant disruptions for that airport, final destination and arrival time. Supported links and Search Suggestions accompany the result. Without a verified road route, the app labels this city-level research and does not assert route impact. Concurrent identical requests are deduplicated. Routing data is cached for 30 minutes and provider failure statuses for five minutes; Grounded Results and Search Suggestions are not cached or stored under [Google's terms](https://ai.google.dev/gemini-api/terms).

## Pipeline and sources

The authenticated, owner-scoped `GET /api/tracked-flights/:id/destination-intelligence` resolves the flight's IATA destination through a bundled airport catalog and small override list. It uses the existing backend-only `SERPAPI_API_KEY` to query SerpApi Google News. Query groups cover full airport name, IATA code, local demonstrations and traffic, transport strikes, severe weather, road closures or major events, and official-domain results for supported countries. There are seven bounded searches when an official domain is configured, six otherwise, with up to 12 results per search. City aliases help match reports that use a different common city name.

Google News supplies headlines, original links, publisher names and publication times. The pipeline does not scrape article bodies or use an LLM. Its official-domain query is a discovery search, **not a direct official advisory feed**. A report is labeled official only if its original HTTPS link is on a recognized authority domain. Zero search results count as a completed search; failed search groups are recorded separately. If all groups fail, the API returns `available: false`. A partial result is marked as partial on the dashboard.

## Selection and event extraction

Reports must be no older than seven days and must mention a resolved city alias, full airport name or airport code. The original link must be HTTPS on a recognized authority, news or local outlet domain, and the headline must contain a traveller-relevant disruption cue. The publisher allowlist reduces unsupported claims but can omit credible outlets. Identical original URLs are removed. Similar reports of the same event type within three days are clustered by headline tokens. A news event requires at least two independent publisher domains; a recognized official source can stand alone. Grouping is deterministic and can both split one incident and merge similar ones.

Each event retains its evidence: original source URLs, names, publication and retrieval times, tier and independent source count. Named areas are extracted only when a headline provides a recognizable street, square, station, terminal, district, airport or destination-prefixed landmark. The field stays empty when a specific area is unsupported. Mentioned transport modes are extracted separately. Impact and guidance use conditional templates based on event type and explicit headline cues. The event title and summary remain source-derived; the system does not invent event dates or an end time.

Severity describes **potential travel disruption**. Civil and road reports start low; transport, airport, severe weather and natural hazard reports start moderate. Explicit closure, evacuation, grounding or emergency language can raise a corroborated event to high. News headlines alone do not produce critical severity. Confidence is medium for two independent news domains and high for at least three or a recognized official source. These labels are qualitative, not calibrated probabilities.

## Cache and diagnostics

MongoDB stores one structured cache document per destination city and country. Fresh cache lasts 30 minutes; an older cache can be served for up to two hours after a failed refresh and is marked stale. A process map and MongoDB provider lease share concurrent refresh work. The dashboard checks every 30 minutes while visible and on tab return. The stored `coverage` records attempted, successful and failed searches plus group-level result counts and query text. `diagnostics` records retrieved, stale, irrelevant, source-rejected, duplicate and accepted reports and events produced. The backend logs aggregate retrieval and analysis counts; credentials are never logged.

The briefing shows the destination and airport, potential disruption, event count, extracted areas and transport, traveller impact, guidance and expandable source links. It shows only filters for categories containing an event. If no event qualifies after successful retrieval, the empty state says so without implying clear conditions. If sources could not be checked, it shows an unavailable state instead.

## Limits and verification

The city report feed has no direct official advisory feed, article-body extraction or geocoding. Headline-only evidence limits location precision, event duration, impact detail and coverage. Search ranking, publication lag and publisher restrictions can yield no qualifying events even when an incident exists. Grounded journey research uses an LLM, but a citation alone does not independently verify that a closure is active. The existing PyTorch flight delay model is separate.

Run `node --test --test-isolation=none` in `backend` for destination and existing service tests. Run `node scripts/e2e-destination.mjs` against a running API for authorization, cache reuse and live reports; set `E2E_DESTINATION_CODE=MIA` or another IATA code to check a different destination. Run `node scripts/inspect-destination-pipeline.mjs MIA` to inspect live query coverage, rejection counts and source-backed events without printing the API key. Run frontend `npm run lint` and `npm run build` for UI validation.
