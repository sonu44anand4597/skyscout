import test from 'node:test';
import assert from 'node:assert/strict';
import { airportSelection, buildFlightSearch, editedAirport, swapAirports } from './flightSearch.js';
import { searchFlights } from '../api/flightApi.js';
const select = (iata, city = iata) => airportSelection({ iata, city, timezone: 'Asia/Kolkata' });
const form = { from: select('BOM', 'Mumbai'), to: select('DEL', 'Delhi'), departure: '2099-01-01', tripType: 'one-way', travellers: { adults: 1, children: 0, infants: 0 }, travelClass: 1 };

test('airport selection retains IATA; editing and clearing invalidate the previous selection', () => {
  assert.equal(form.from.airport.iata, 'BOM'); assert.equal(form.from.text, 'Mumbai (BOM)');
  for (const text of ['Mumbai', 'Mumbai (BOM)', '']) assert.equal(editedAirport(text).airport, null);
  assert.match(buildFlightSearch({ ...form, from: editedAirport('Mumbai (BOM)') }).error, /suggestions/);
});
test('swap exchanges complete airport identity and submissions contain actual IATA values', () => {
  const swapped = swapAirports(form.from, form.to); assert.equal(swapped.from, form.to); assert.equal(swapped.to, form.from);
  assert.equal(buildFlightSearch({ ...form, ...swapped }).data.origin, 'DEL');
  assert.equal(buildFlightSearch({ ...form, ...swapped }).data.destination, 'BOM');
});
test('identical airports, impossible/past dates and invalid passenger/cabin choices are rejected', () => {
  for (const changes of [{ to: select('BOM', 'Bombay') }, { departure: '2099-02-31' }, { departure: '2020-01-01' }, { travellers: { adults: 0, children: 0, infants: 0 } }, { travellers: { adults: 9, children: 1, infants: 0 } }, { travellers: { adults: 1, children: 0, infants: 2 } }, { travelClass: 7 }]) assert.ok(buildFlightSearch({ ...form, ...changes }).error);
});
test('one-way and round-trip preserve cabin and all traveler selections', () => {
  const options = { ...form, travellers: { adults: 2, children: 1, infants: 1 }, travelClass: 3 };
  assert.deepEqual(buildFlightSearch(options).data, { origin: 'BOM', destination: 'DEL', departure: form.departure, returnDate: null, tripType: 'one-way', adults: 2, children: 1, infants: 1, travelClass: 3 });
  assert.equal(buildFlightSearch({ ...options, tripType: 'round-trip', returnDate: '2099-01-03' }).data.returnDate, '2099-01-03');
  assert.ok(buildFlightSearch({ ...form, tripType: 'round-trip', returnDate: '2098-12-31' }).error);
});
test('multi-city requires connected real airport selections and chronological dates without becoming one-way', () => {
  const multiLegs = [{ from: form.from, to: form.to, date: '2099-01-01' }, { from: form.to, to: select('BLR'), date: '2099-01-03' }];
  const result = buildFlightSearch({ ...form, tripType: 'multi-city', multiLegs });
  assert.equal(result.data.tripType, 'multi-city'); assert.deepEqual(result.data.legs, [{ from: 'BOM', to: 'DEL', date: '2099-01-01' }, { from: 'DEL', to: 'BLR', date: '2099-01-03' }]);
  assert.ok(buildFlightSearch({ ...form, tripType: 'multi-city', multiLegs: [multiLegs[0], { ...multiLegs[1], from: select('MAA') }] }).error);
  assert.ok(buildFlightSearch({ ...form, tripType: 'multi-city', multiLegs: [multiLegs[0], { ...multiLegs[1], date: '2098-12-31' }] }).error);
});
test('date validation uses origin timezone rather than the browser calendar day', () => {
  const from = airportSelection({ iata: 'LAX', city: 'Los Angeles', timezone: 'America/Los_Angeles' });
  assert.ok(buildFlightSearch({ ...form, from, departure: '2026-10-29' }, new Date('2026-10-30T01:00:00Z')).data);
});

test('the frontend API sends all three trip configurations to the actual search endpoint contract', async (context) => {
  const requested = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ success: true, data: [] }), { headers: { 'Content-Type': 'application/json' } });
  });
  for (const tripType of ['one-way', 'round-trip', 'multi-city']) {
    const input = { origin: 'BOM', destination: 'DEL', departure: '2099-01-01', returnDate: '2099-01-05', tripType, adults: 2, children: 1, infants: 1, travelClass: 4, legs: [{ from: 'BOM', to: 'DEL', date: '2099-01-01' }, { from: 'DEL', to: 'BLR', date: '2099-01-03' }] };
    await searchFlights(input);
    const { url, options } = requested.at(-1); assert.equal(url.pathname, '/api/flights/search'); assert.equal(options.credentials, 'include');
    const p = url.searchParams; assert.equal(p.get('origin'), 'BOM'); assert.equal(p.get('destination'), 'DEL'); assert.equal(p.get('tripType'), tripType); assert.equal(p.get('adults'), '2'); assert.equal(p.get('children'), '1'); assert.equal(p.get('infants'), '1'); assert.equal(p.get('travelClass'), '4');
    if (tripType === 'round-trip') assert.equal(p.get('returnDate'), input.returnDate);
    if (tripType === 'multi-city') assert.deepEqual(JSON.parse(p.get('legs')), input.legs);
  }
});
