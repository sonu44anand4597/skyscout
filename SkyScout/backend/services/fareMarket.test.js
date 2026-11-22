import test from 'node:test';
import assert from 'node:assert/strict';
import { getFareMarket } from './fareMarket.js';

const now = new Date('2026-11-01T10:00:00Z');
const flight = { _id: 'market-flight', userId: 'market-owner', origin: 'DEL', destination: 'BLR', departureDate: '2026-12-01', departureAt: '2026-12-01 10:00', tripType: 'one-way', airline: 'IndiGo', flightNumber: '6E 123', currency: 'INR', currentPrice: 5000, adults: 2, children: 1, infants: 0, travelClass: 2 };
const offer = { id: 'offer', from: 'DEL', to: 'BLR', departureAt: '2026-12-01 10:00', flightNumber: '6E123', airline: 'Indigo', price: 4500, currency: 'INR' };
const deps = { now, read: async () => null, store: async () => {} };

test('market request preserves cabin/passenger identity, rejects other dates/currencies and saves only selected itinerary', async () => {
  let args; const saved = [];
  const result = await getFareMarket(flight, { ...deps, record: async (...data) => saved.push(data), search: async (input) => {
    args = input;
    return { flights: [offer, { ...offer, id: 'competitor', flightNumber: 'AI456', airline: 'Air India', price: 4800 }, { ...offer, currency: 'USD' }, { ...offer, departureAt: '2026-12-02 10:00' }], searchedAt: now.toISOString() };
  } });
  assert.equal(args.travelClass, 2); assert.equal(args.adults, 2); assert.equal(args.children, 1);
  assert.equal(result.offers.length, 2); assert.equal(result.matchedFare, 4500); assert.equal(saved.length, 1);
  assert.equal(result.offers[1].difference, 300);
});

test('market provider failure retains prior real offers as stale', async () => {
  const result = await getFareMarket({ ...flight, _id: 'market-failure' }, { ...deps, read: async () => ({ status: 'available', offers: [offer], quotedAt: now.toISOString(), expiresAt: 0 }), search: async () => { throw Object.assign(new Error('SerpApi quota'), { providerCode: 'quota_exceeded', providerStatus: 429 }); } });
  assert.equal(result.stale, true); assert.equal(result.offers[0].price, 4500); assert.equal(result.lastAttempt.httpStatus, 429);
});

test('concurrent market requests share one provider request', async () => {
  let called = 0;
  const dependencies = { ...deps, record: async () => {}, search: async () => { called++; await new Promise((resolve) => setTimeout(resolve, 5)); return { flights: [offer], searchedAt: now.toISOString() }; } };
  await Promise.all([getFareMarket({ ...flight, _id: 'market-concurrent' }, dependencies), getFareMarket({ ...flight, _id: 'market-concurrent' }, dependencies)]);
  assert.equal(called, 1);
});

test('an old provider result is rechecked without cache and never saved if still stale', async () => {
  const requests = []; let recorded = false;
  const result = await getFareMarket({ ...flight, _id: 'market-stale-quote' }, { ...deps, record: async () => { recorded = true; }, search: async (input) => { requests.push(input); return { flights: [offer], searchedAt: new Date(now.getTime() - 3600000).toISOString() }; } });
  assert.equal(requests.length, 2); assert.equal(requests[1].fresh, true);
  assert.equal(recorded, false); assert.equal(result.stale, true);
});

test('market availability follows the origin date and scheduled instant across UTC midnight', async () => {
  const lateUS = { ...flight, _id: 'late-us-market', origin: 'LAX', destination: 'JFK', departureDate: '2026-11-01', departureAt: '2026-11-01 23:00' };
  let called = 0;
  const search = async () => { called++; return { flights: [], searchedAt: '2026-11-02T02:00:00Z' }; };
  assert.equal((await getFareMarket(lateUS, { ...deps, now: new Date('2026-11-02T02:00:00Z'), search })).status, 'available');
  assert.equal(called, 1);
  assert.equal((await getFareMarket({ ...flight, departureDate: '2026-11-01', departureAt: '2026-11-01 09:00' }, { ...deps, now: new Date('2026-11-01T04:00:00Z'), search })).status, 'departure_reached');
  assert.equal(called, 1, 'an already departed local-time itinerary must not spend provider quota');
});

test('fare-market responses never expose raw provider or database exception text', async () => {
  const secret = 'mongodb://user:private-password@private-host';
  const result = await getFareMarket({ ...flight, _id: 'safe-market-error' }, { ...deps, search: async () => { throw new Error(secret); } });
  assert.equal(result.status, 'provider_unavailable');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.message, /last verified fare was preserved/);
});
