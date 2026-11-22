import test from "node:test";
import assert from "node:assert/strict";
import { groundedResponse, normalizeGroundedEvents } from "./groundedEvents.js";

const source = "https://nhai.gov.in/assets/pdf/NHAI_Table_Calendar-2026.pdf";
const metadata = { groundingChunks: [{ web: { uri: source, title: "National Highways Authority of India" } }], groundingSupports: [{ groundingChunkIndices: [0] }] };
const context = { kind: "fare", origin: "DEL", destination: "BLR", originCity: "Delhi", destinationCity: "Bengaluru", airline: "IndiGo", travelDate: "2026-11-08" };
const event = { title: "**Diwali**", category: "holiday", summary: "National holiday on the selected travel date.", eventStart: "2026-11-08", eventEnd: null, location: "India", affectedAirports: ["DEL"], affectedAirlines: [], affectedRoads: [], impactDirection: "uncertain", impactExplanation: "A holiday can shift demand, but the direction for this exact flight has not been measured.", sourceTitle: "National Highways Authority of India", sourceUrl: source, publishedAt: null };

test("grounded event normalization strips Markdown and requires a cited, itinerary-relevant source", () => {
  const result = normalizeGroundedEvents(JSON.stringify({ events: [event] }), metadata, context, "2026-10-15T00:00:00Z");
  assert.equal(result.status, "events_available");
  assert.equal(result.events[0].title, "Diwali");
  assert.equal(result.events[0].evidenceStatus, "possible");
  assert.equal(result.events[0].sourceUrl, source);
  assert.equal(result.events[0].relevance.reason, "Names this flight's airport.");
});

test("unrelated, uncited and impossible-date events are excluded", () => {
  const unrelated = { ...event, affectedAirports: ["JFK"], location: "New York" };
  const uncited = { ...event, sourceUrl: "https://other.example/claim", sourceTitle: "Other" };
  const impossible = { ...event, eventStart: "2026-02-31" };
  const result = normalizeGroundedEvents(JSON.stringify({ events: [unrelated, uncited, impossible] }), metadata, context);
  assert.equal(result.status, "no_qualifying_event");
  assert.equal(result.excludedCount, 3);
});

test("a dated event overlapping departure remains eligible even when it began earlier", () => {
  const multiDay = { ...event, eventStart: "2026-10-25", eventEnd: "2026-11-08" };
  assert.equal(normalizeGroundedEvents(JSON.stringify({ events: [multiDay] }), metadata, context).events.length, 1);
});

test("destination road impact requires a named road in an actual provider route", () => {
  const road = { ...event, category: "road", affectedAirports: [], affectedRoads: ["Airport Road"], location: "Bengaluru", eventStart: "2026-11-08" };
  const destination = { kind: "destination", destination: "BLR", destinationCity: "Bengaluru", travelDate: "2026-11-08", routes: [{ summary: "Airport Road", steps: [] }] };
  assert.equal(normalizeGroundedEvents(JSON.stringify({ events: [road] }), metadata, destination).events[0].routeImpactStatus, "possibly_affected");
  assert.equal(normalizeGroundedEvents(JSON.stringify({ events: [road] }), metadata, { ...destination, routes: [] }).events[0].routeImpactStatus, "not_verified_as_affected");
});


test("recent national fuel context is retained without inventing a route-specific pressure", () => {
  const fuel = { ...event, category: "fuel", title: "National aviation fuel update", eventStart: "2026-10-10", publishedAt: "2026-10-10", location: "India national aviation market", affectedAirports: [], impactDirection: "upward" };
  const result = normalizeGroundedEvents(JSON.stringify({ events: [fuel] }), metadata, { ...context, today: "2026-10-15" });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].relevance.level, "CONTEXT");
  assert.equal(result.events[0].impactDirection, "uncertain");
  assert.equal(result.events[0].quantitativeAdjustment, 0);
});

test("citation offsets cannot support another event's claim", () => {
  const text = JSON.stringify({ events: [event] });
  const misplaced = { ...metadata, groundingSupports: [{ segment: { startIndex: text.length + 1, endIndex: text.length + 10 }, groundingChunkIndices: [0] }] };
  const result = normalizeGroundedEvents(text, misplaced, context);
  assert.equal(result.events.length, 0);
  assert.equal(result.diagnostics.exclusions.no_matching_supported_source, 1);
});

test('labeled grounded prose uses overlapping claim citations without requiring model-authored source URLs', () => {
  const text = `EVENT
Title: Airport advisory
Category: airport
Summary: A cited airport advisory is active on departure.
Start: 2026-11-08
End: unknown
Location: Bengaluru
Airports: BLR
Airlines: none
Roads: none
Direction: uncertain
Mechanism: Airport operations may be affected, but no measured fare effect is known.
Published: 2026-10-15`;
  const grounded = { ...metadata, groundingSupports: [{ segment: { startIndex: text.indexOf('Summary:'), endIndex: text.indexOf('Start:') }, groundingChunkIndices: [0] }] };
  const result = normalizeGroundedEvents(text, grounded, context);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].sourceUrl, source);
  assert.equal(result.events[0].title, 'Airport advisory');
});

test('economic context from an unrelated national market is excluded', () => {
  const fuel = { ...event, title: 'India fuel rates', category: 'fuel', eventStart: '2026-10-10', publishedAt: '2026-10-10', location: 'India', affectedAirports: [] };
  const result = normalizeGroundedEvents(JSON.stringify({ events: [fuel] }), metadata, { ...context, origin: 'LAX', destination: 'MIA', originCountry: 'US', destinationCountry: 'US', today: '2026-10-15' });
  assert.equal(result.events.length, 0);
});

test('UTF-8 citation offsets preserve non-ASCII event attribution', () => {
  const text = `${'यात्रा '.repeat(100)}\nEVENT\nTitle: Bengaluru advisory\nCategory: airport\nSummary: Airport operations may be disrupted on the selected travel date.\nStart: 2026-11-08\nEnd: unknown\nLocation: Bengaluru\nAirports: BLR\nAirlines: none\nRoads: none\nDirection: uncertain\nMechanism: Airport operations could be affected but no numerical fare effect has been established.\nPublished: 2026-10-15`;
  const start = Buffer.byteLength(text.slice(0, text.indexOf('Summary:')), 'utf8');
  const end = Buffer.byteLength(text.slice(0, text.indexOf('Start:')), 'utf8');
  const result = normalizeGroundedEvents(text, { ...metadata, groundingSupports: [{ segment: { startIndex: start, endIndex: end }, groundingChunkIndices: [0] }] }, context);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].sourceUrl, source);
});

test('multipart grounding offsets follow their text Part and never use thought citations', () => {
  const text = JSON.stringify({ events: [event] });
  const response = groundedResponse({ candidates: [{ content: { parts: [{ text: 'अनुसंधान', thought: true }, { text: 'Preamble: résumé\n' }, { text }] }, groundingMetadata: { ...metadata, groundingSupports: [
    { segment: { partIndex: 0, startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] },
    { segment: { partIndex: 2, endIndex: Buffer.byteLength(text, 'utf8') }, groundingChunkIndices: [0] },
  ] } }] });
  assert.equal(response.text, `Preamble: résumé\n${text}`);
  assert.equal(response.metadata.groundingSupports.length, 1);
  assert.equal(normalizeGroundedEvents(response.text, response.metadata, context).events.length, 1);
});

test('future event dates remain eligible but future publication dates are rejected', () => {
  const result = normalizeGroundedEvents(JSON.stringify({ events: [{ ...event, publishedAt: '2026-11-01' }] }), metadata, { ...context, today: '2026-10-15' });
  assert.equal(result.events.length, 0);
  assert.equal(result.diagnostics.exclusions.publication_in_future, 1);
});
