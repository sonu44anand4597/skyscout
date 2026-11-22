import test from "node:test";
import assert from "node:assert/strict";
import { getFareIntelligence } from "./fareIntelligenceService.js";
import PriceObservation from "../models/PriceObservation.js";
import { FARE_ENGINE_VERSION } from "./fareBaseline.js";
import TrackedFlight from "../models/TrackedFlight.js";
import { flightFareIntelligence } from "../controllers/trackedFlightController.js";

const now = new Date("2026-10-15T10:00:00Z");
const flight = { _id: "flight-1", userId: "user-1", origin: "DEL", destination: "BLR", departureDate: "2026-11-01", tripType: "one-way", currency: "INR", airline: "IndiGo" };
const observations = [{ userId: flight.userId, trackedFlightId: flight._id, price: 5000, currency: "INR", observedAt: new Date("2026-10-15T09:00:00Z") }];

test("GET computes baseline without calling Gemini", async () => {
  let called = false;
  const result = await getFareIntelligence(flight, {
    now, findObservations: async () => observations, findAnalyses: async () => [],
    saveAnalysis: async (data) => ({ ...data, _id: "analysis-1" }),
    discover: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.baseline.currentFare, 5000);
  assert.equal(result.baseline.status, "insufficient_data");
  assert.equal(result.eventIntelligence.status, "not_checked");
});

test("research returns structured events only in the live response and persists status only", async () => {
  const priorKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  let update;
  try {
    const result = await getFareIntelligence(flight, {
      now, research: true, findObservations: async () => observations, findAnalyses: async () => [],
      saveAnalysis: async (data) => ({ ...data, _id: "analysis-2" }),
      updateAnalysis: async (_id, data) => { update = data; return { _id, ...data }; },
      cooldown: async () => true, quota: async () => true,
      discover: async () => ({ status: "grounded_result", events: [{ id: "event-1", title: "Airport disruption" }], searchSuggestionsHtml: "<div>Suggestions</div>", checkedAt: now.toISOString() }),
    });
    assert.equal(result.eventIntelligence.events[0].title, "Airport disruption");
    assert.equal(result.eventIntelligence.groundedText, undefined);
    assert.equal(result.priceHistory.length, 1);
    assert.deepEqual(update, { researchLastStatus: "grounded_result", researchCheckedAt: now.toISOString() });
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  }
});

test("previously researched snapshots do not imply saved grounded content is available", async () => {
  const result = await getFareIntelligence({ ...flight, _id: "flight-prior" }, {
    now, findObservations: async () => observations,
    findAnalyses: async () => [{ _id: "analysis-3", engineVersion: FARE_ENGINE_VERSION, observedFare: 5000, bookingDate: "2026-10-15", observedAt: observations[0].observedAt, researchLastStatus: "grounded_result", researchCheckedAt: now }],
  });
  assert.equal(result.eventIntelligence.status, "previously_researched");
  assert.equal(result.eventIntelligence.groundedText, undefined);
});

test("fare endpoint rejects another user's tracked itinerary", async (context) => {
  const id = "507f1f77bcf86cd799439011";
  const owner = "507f1f77bcf86cd799439012";
  let query;
  context.mock.method(TrackedFlight, "findOne", (filter) => {
    query = filter;
    return { lean: async () => null };
  });
  const req = { params: { id }, userId: owner, method: "GET" };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await flightFareIntelligence(req, res, () => {});
  assert.deepEqual(query, { _id: id, userId: owner });
  assert.equal(res.code, 404);
});

test("missing fare does not block research and provider errors do not claim cooldown", async () => {
  const priorKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  const cooldownCalls = [];
  try {
    const result = await getFareIntelligence({ ...flight, _id: "flight-missing" }, {
      now, research: true, findObservations: async () => [], findAnalyses: async () => [],
      saveAnalysis: async () => { throw new Error("No fare snapshot should be saved"); },
      cooldown: async (options) => { cooldownCalls.push(options); return true; }, quota: async () => true,
      discover: async () => ({ status: "quota_exceeded", checkedAt: now.toISOString() }),
    });
    assert.equal(result.baseline.currentFare, null);
    assert.equal(result.eventIntelligence.status, "quota_exceeded");
    assert.deepEqual(cooldownCalls, [undefined]);
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  }
});


test("default observation query keeps the latest 500 quotes in chronological order", async (context) => {
  let sort;
  let limit;
  context.mock.method(PriceObservation, "find", () => ({
    sort(value) { sort = value; return this; },
    limit(value) { limit = value; return this; },
    lean: async () => [{ ...observations[0], price: 5500 }, { ...observations[0], price: 5000, observedAt: new Date("2026-10-14T09:00:00Z") }],
  }));
  const result = await getFareIntelligence(flight, {
    now, findAnalyses: async () => [], saveAnalysis: async (data) => ({ ...data, _id: "latest" }),
  });
  assert.deepEqual(sort, { observedAt: -1 });
  assert.equal(limit, 500);
  assert.equal(result.baseline.currentFare, 5500);
  assert.deepEqual(result.priceHistory.map((item) => item.price), [5000, 5500]);
});


test("authorized persistent report is reused without provider calls", async () => {
  const result = await getFareIntelligence({ ...flight, _id: "cache-fresh" }, {
    now, research: true, findObservations: async () => observations, findAnalyses: async () => [], saveAnalysis: async (data) => ({ ...data, _id: "cache-analysis" }),
    loadReport: async () => ({ report: { status: "grounded_result", events: [{ id: "cached-event" }], checkedAt: now.toISOString() }, expiresAt: new Date(now.getTime() + 60000) }),
    discover: async () => { throw new Error("Fresh report must avoid provider call"); },
  });
  assert.equal(result.eventIntelligence.events[0].id, "cached-event");
  assert.equal(result.eventIntelligence.cache, "persistent");
});

test("expired sourced report survives provider quota failure with original timestamp", async () => {
  const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = "test";
  const checkedAt = "2026-10-14T10:00:00Z";
  try {
    const result = await getFareIntelligence({ ...flight, _id: "cache-stale" }, {
      now, research: true, findObservations: async () => observations, findAnalyses: async () => [], saveAnalysis: async (data) => ({ ...data, _id: "stale-analysis" }), updateAnalysis: async () => ({}),
      loadReport: async () => ({ report: { status: "grounded_result", events: [{ id: "retained" }], checkedAt }, expiresAt: new Date("2026-10-14T16:00:00Z") }),
      cooldown: async () => true, quota: async () => true, discover: async () => ({ status: "quota_exceeded", checkedAt: now.toISOString() }),
    });
    assert.equal(result.eventIntelligence.events[0].id, "retained");
    assert.equal(result.eventIntelligence.stale, true);
    assert.equal(result.eventIntelligence.checkedAt, checkedAt);
    assert.equal(result.eventIntelligence.lastAttempt.status, "quota_exceeded");
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});

test('report storage failures do not erase independent fare evidence or valid fresh research', async () => {
  const prior = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test';
  try {
    const result = await getFareIntelligence({ ...flight, _id: 'storage-unavailable' }, {
      now, research: true, findObservations: async () => observations, findAnalyses: async () => [],
      saveAnalysis: async (data) => ({ ...data, _id: 'storage-analysis' }), updateAnalysis: async () => ({}),
      loadReport: async () => { throw new Error('Report collection unavailable'); },
      saveReport: async () => { throw new Error('Report write unavailable'); },
      cooldown: async () => true, quota: async () => true,
      discover: async () => ({ status: 'grounded_result', events: [{ id: 'fresh-evidence' }], checkedAt: now.toISOString() }),
    });
    assert.equal(result.baseline.currentFare, 5000);
    assert.equal(result.eventIntelligence.events[0].id, 'fresh-evidence');
    assert.equal(result.eventIntelligence.storageStatus, 'unavailable');
  } finally { if (prior === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prior; }
});
