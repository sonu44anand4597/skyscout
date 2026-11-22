import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationArrival, routesBetween } from './routingService.js';

test('round-trip destination uses outbound arrival while multi-city uses the final leg', () => {
  const flight = { destination: 'BLR', segments: [{ destination: { time: 'return time' } }], tripType: 'round-trip', roundTripLegs: [{ to: 'BLR', arrival: 'outbound time' }, { to: 'DEL', arrival: 'return time' }] };
  assert.deepEqual(destinationArrival(flight), { airportCode: 'BLR', arrivalAt: 'outbound time' });
  assert.deepEqual(destinationArrival({ ...flight, tripType: 'multi-city', journeyLegs: [{ to: 'BOM', arrivalAt: 'final time' }] }), { airportCode: 'BOM', arrivalAt: 'final time' });
});
test('ambiguous destinations and no route never become fabricated estimates', async () => {
  const old = process.env.GOOGLE_MAPS_API_KEY; process.env.GOOGLE_MAPS_API_KEY = 'fixture';
  try {
    const airport = { airportName: 'Bengaluru', airportCode: 'BLR', city: 'Bengaluru', countryCode: 'IN' };
    const ambiguous = await routesBetween(airport, 'Ambiguous area', null, async () => ({ ok: true, json: async () => ({ geocodingResults: { destination: { partialMatch: true } }, routes: [] }) }));
    assert.equal(ambiguous.status, 'ambiguous_destination');
    const empty = await routesBetween(airport, 'No road', null, async () => ({ ok: true, json: async () => ({ routes: [] }) }));
    assert.equal(empty.status, 'no_route');
    const denied = await routesBetween(airport, 'Koramangala', null, async () => ({ ok: false, json: async () => ({ error: { status: 'PERMISSION_DENIED' } }) }));
    assert.equal(denied.status, 'configuration_error');
  } finally { if (old === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = old; }
});
