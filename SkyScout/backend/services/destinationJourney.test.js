import test from 'node:test';
import assert from 'node:assert/strict';
import { getDestinationJourney, routeBetween, researchJourney } from './destinationJourney.js';

const airport = { airportName: 'Kempegowda International Airport', airportCode: 'BLR', city: 'Bengaluru' };
test('missing Maps credential reports the exact independent dependency', async () => {
  const old = process.env.GOOGLE_MAPS_API_KEY; delete process.env.GOOGLE_MAPS_API_KEY;
  try { assert.match((await routeBetween(airport, 'Koramangala', null)).message, /GOOGLE_MAPS_API_KEY/); }
  finally { if (old !== undefined) process.env.GOOGLE_MAPS_API_KEY = old; }
});
test('Routes API response is normalized with its exact distance and supported traffic duration', async () => {
  const old = process.env.GOOGLE_MAPS_API_KEY; process.env.GOOGLE_MAPS_API_KEY = 'test';
  try {
    let submitted;
    const result = await routeBetween(airport, 'Koramangala', '2026-12-01T10:00:00Z', async (url, options) => {
      submitted = { url, ...options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ geocodingResults: { destination: { placeId: 'verified-place' } }, routes: [{ description: 'NH 44', distanceMeters: 40000, staticDuration: '3600s', duration: '4200s', polyline: { encodedPolyline: 'encoded' }, legs: [{ steps: [{ navigationInstruction: { instructions: 'Turn onto NH 44' } }] }] }] }) };
    });
    assert.equal(submitted.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
    assert.equal(submitted.method, 'POST');
    assert.equal(submitted.body.routingPreference, 'TRAFFIC_AWARE');
    assert.match(submitted.headers['X-Goog-FieldMask'], /geocodingResults/);
    assert.equal(result.routes[0].durationText, '60 min'); assert.equal(result.routes[0].trafficDurationText, '70 min');
    assert.equal(result.routes[0].distanceMeters, 40000);
    assert.equal(result.geocodedDestination.placeId, 'verified-place');
    assert.deepEqual(result.routes[0].steps, ['Turn onto NH 44']);
  } finally { if (old === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = old; }
});
test('journey research reports quota failure independently of road routing', async () => {
  const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'test';
  try {
    const result = await researchJourney(airport, 'Koramangala', '2026-12-01T10:00:00Z', { status: 'not_configured' }, async () => { throw Object.assign(new Error('quota'), { status: 429 }); }, async () => true);
    assert.equal(result.status, 'quota_exceeded');
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});

function groundedFixture() {
  const text = `EVENT\nTitle: Fixture airport advisory\nCategory: airport\nSummary: A controlled provider fixture describes an airport advisory on arrival.\nStart: 2026-12-01\nEnd: unknown\nLocation: Bengaluru\nAirports: BLR\nAirlines: none\nRoads: none\nDirection: uncertain\nMechanism: This fixture tests evidence handling and does not establish a route closure or fare effect.\nPublished: unknown`;
  return { text, candidates: [{ groundingMetadata: { webSearchQueries: ['fixture advisory'], groundingChunks: [{ web: { uri: 'https://example.org/fixture-advisory', title: 'Controlled fixture source' } }], groundingSupports: [{ segment: { startIndex: text.indexOf('Summary:'), endIndex: text.indexOf('Start:') }, groundingChunkIndices: [0] }], searchEntryPoint: { renderedContent: '<div>Controlled Search Suggestions fixture</div>' } } }] };
}

test('Maps and report-storage failures preserve independently grounded destination findings', async () => {
  const oldGemini = process.env.GEMINI_API_KEY;
  const oldMaps = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GEMINI_API_KEY = 'test'; delete process.env.GOOGLE_MAPS_API_KEY;
  try {
    const result = await getDestinationJourney(airport, 'Koramangala', '2026-12-01T10:00:00Z', {
      flight: { _id: 'storage-fixture', userId: 'fixture-owner', origin: 'BOM', destination: 'BLR' },
      loadReport: async () => { throw new Error('Controlled store failure'); }, saveReport: async () => { throw new Error('Controlled store failure'); },
      generate: async () => groundedFixture(), claimBudget: async () => true,
    });
    assert.equal(result.routing.status, 'not_configured');
    assert.equal(result.research.status, 'grounded_result');
    assert.equal(result.research.events[0].title, 'Fixture airport advisory');
    assert.equal(result.research.storageStatus, 'unavailable');
    assert.equal(result.research.events[0].routeImpactStatus, 'not_verified_as_affected');
  } finally {
    if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
    if (oldMaps !== undefined) process.env.GOOGLE_MAPS_API_KEY = oldMaps;
  }
});

test('persisted journey reports survive a new service instance without repeating Gemini', async () => {
  const oldGemini = process.env.GEMINI_API_KEY;
  const oldMaps = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GEMINI_API_KEY = 'test'; delete process.env.GOOGLE_MAPS_API_KEY;
  let saved;
  let calls = 0;
  const options = {
    flight: { _id: 'restart-fixture', userId: 'fixture-owner', origin: 'BOM', destination: 'BLR' },
    loadReport: async () => saved,
    saveReport: async (_identity, _flight, report) => { saved = { report: structuredClone(report), expiresAt: new Date(Date.now() + 60000) }; },
    generate: async () => { calls++; return groundedFixture(); }, claimBudget: async () => true,
  };
  try {
    const first = await getDestinationJourney(airport, 'Koramangala', '2026-12-01T10:00:00Z', options);
    const restartedService = await import('./destinationJourney.js?restart-fixture');
    const restored = await restartedService.getDestinationJourney(airport, 'Koramangala', '2026-12-01T10:00:00Z', options);
    assert.equal(calls, 1);
    assert.deepEqual(restored.research.events, first.research.events);
    assert.equal(restored.research.checkedAt, first.research.checkedAt);
    assert.equal(restored.research.cache, 'persistent');
  } finally {
    if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
    if (oldMaps !== undefined) process.env.GOOGLE_MAPS_API_KEY = oldMaps;
  }
});
