import test from 'node:test';
import assert from 'node:assert/strict';
import IntelligenceReport from '../models/IntelligenceReport.js';
import { canStoreGrounding, readReport, reportIdentity, writeReport } from './intelligenceReports.js';
test('research identities separate owners, dates, cabins, passengers and connecting segment identities', () => {
  const flight = { _id: 'track', userId: 'owner', origin: 'DEL', destination: 'BLR', departureDate: '2026-11-25', airline: 'IndiGo', travelClass: 1, adults: 1, currency: 'INR', segments: [{ flightNumber: '6E 1', origin: { code: 'DEL', time: '2026-11-25 10:00' }, destination: { code: 'BLR' } }] };
  const key = reportIdentity(flight).key;
  assert.equal(reportIdentity({ ...flight }).key, key);
  for (const change of [{ userId: 'other' }, { departureDate: '2026-11-26' }, { travelClass: 2 }, { adults: 2 }, { segments: [{ ...flight.segments[0], flightNumber: '6E 2' }] }]) assert.notEqual(reportIdentity({ ...flight, ...change }).key, key);
  assert.notEqual(reportIdentity(flight, 'destination', 'Koramangala').key, key);
});

test('destination report identity includes the actual round-trip and multi-city arrival legs', () => {
  const flight = { _id: 'track', userId: 'owner', origin: 'BOM', destination: 'BLR', journeyLegs: [{ from: 'DEL', to: 'BLR', arrivalAt: '2026-12-01 18:00' }] };
  assert.notEqual(reportIdentity(flight, 'destination', 'Koramangala').key, reportIdentity({ ...flight, journeyLegs: [{ from: 'DEL', to: 'BLR', arrivalAt: '2026-12-02 18:00' }] }, 'destination', 'Koramangala').key);
  assert.equal(reportIdentity(flight, 'destination', '  Koramangala   Bengaluru ').key, reportIdentity(flight, 'destination', 'koramangala bengaluru').key);
});

test('grounded report persistence stays disabled without provider storage authorization', async (context) => {
  const prior = process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED;
  delete process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED;
  context.mock.method(IntelligenceReport, 'findOne', () => { throw new Error('Unauthorized storage must not be read'); });
  context.mock.method(IntelligenceReport, 'updateOne', () => { throw new Error('Unauthorized storage must not be written'); });
  try {
    assert.equal(canStoreGrounding(), false);
    assert.equal(await readReport('key'), null);
    assert.equal(await writeReport({ key: 'key' }, {}, {}), false);
  } finally { if (prior !== undefined) process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED = prior; }
});

test('authorized persistence preserves full normalized report and enforces retention on reads', async (context) => {
  const prior = process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED;
  process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED = 'true';
  const now = new Date('2026-11-03T10:00:00Z');
  const report = { status: 'grounded_result', checkedAt: now.toISOString(), events: [{ id: 'event', title: 'Sourced advisory', sourceUrl: 'https://example.org/advisory' }], searchSuggestionsHtml: '<div>Google Search Suggestions</div>' };
  let saved;
  let query;
  context.mock.method(IntelligenceReport, 'updateOne', async (_query, update) => { saved = update.$set; });
  context.mock.method(IntelligenceReport, 'findOne', (filter) => { query = filter; return { lean: async () => structuredClone(saved) }; });
  try {
    assert.equal(await writeReport({ key: 'identity', itinerary: { origin: 'BOM' } }, { userId: 'user', _id: 'flight' }, report, now), true);
    const restored = await readReport('identity', now);
    assert.deepEqual(restored.report, report);
    assert.equal(restored.expiresAt.toISOString(), '2026-11-03T16:00:00.000Z');
    assert.equal(restored.purgeAt.toISOString(), '2026-11-10T10:00:00.000Z');
    assert.deepEqual(query, { key: 'identity', purgeAt: { $gt: now } });
    assert.equal(await writeReport({ key: 'identity' }, {}, { ...report, status: 'quota_exceeded' }), false);
    assert.equal(await writeReport({ key: 'identity' }, {}, { ...report, checkedAt: 'invalid' }), false);
  } finally { if (prior === undefined) delete process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED; else process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED = prior; }
});
