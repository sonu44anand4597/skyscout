import test from "node:test";
import assert from "node:assert/strict";
import { discoverFareEvents } from "./fareEvents.js";

const flight = { origin: "DEL", destination: "BLR", airline: "IndiGo", departureDate: "2026-10-28" };
const grounded = { text: JSON.stringify({ events: [{ title: "Bengaluru airport disruption", category: "airport", summary: "Airport operations may be affected on the selected travel date.", eventStart: "2026-10-28", eventEnd: null, location: "Bengaluru", affectedAirports: ["BLR"], affectedAirlines: [], affectedRoads: [], impactDirection: "uncertain", impactExplanation: "An operational disruption at the arrival airport could affect seat supply and this itinerary.", sourceTitle: "Source", sourceUrl: "https://example.org/event", publishedAt: "2026-10-15" }] }), candidates: [{ groundingMetadata: {
  webSearchQueries: ["Bengaluru event"],
  groundingChunks: [{ web: { uri: "https://example.org/event", title: "Source" } }],
  groundingSupports: [{ segment: { text: "A cited event near Bengaluru." }, groundingChunkIndices: [0] }],
  searchEntryPoint: { renderedContent: "<div>Google Search Suggestions</div>" },
} }] };

test("grounded research returns result and Search Suggestions together", async () => {
  const result = await discoverFareEvents(flight, "2026-10-15", { apiKey: "test", generate: async () => grounded });
  assert.equal(result.status, "grounded_result");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].affectedAirports[0], "BLR");
  assert.equal(result.events[0].sourceUrl, "https://example.org/event");
  assert.equal(result.events[0].evidenceStatus, "possible");
  assert.equal(result.groundedText, undefined);
  assert.equal(result.searchSuggestionsHtml, grounded.candidates[0].groundingMetadata.searchEntryPoint.renderedContent);
});

test("missing source support or Search Suggestions cannot be shown as grounded", async () => {
  for (const metadata of [{}, { ...grounded.candidates[0].groundingMetadata, groundingSupports: [] }, { ...grounded.candidates[0].groundingMetadata, searchEntryPoint: null }]) {
    const result = await discoverFareEvents(flight, "2026-10-15", { apiKey: "test", generate: async () => ({ ...grounded, candidates: [{ groundingMetadata: metadata }] }) });
    assert.equal(result.status, "grounding_unavailable");
    assert.equal(result.groundedText, undefined);
  }
});

test("provider failures have explicit statuses without fabricated research", async () => {
  assert.equal((await discoverFareEvents(flight, "2026-10-15", { apiKey: "" })).status, "not_configured");
  for (const [status, expected] of [[429, "quota_exceeded"], [401, "invalid_key"], [404, "unsupported_model"]]) {
    const result = await discoverFareEvents(flight, "2026-10-15", { apiKey: "test", generate: async () => { throw Object.assign(new Error("failed"), { status }); } });
    assert.equal(result.status, expected);
    assert.equal(result.groundedText, undefined);
  }
});
