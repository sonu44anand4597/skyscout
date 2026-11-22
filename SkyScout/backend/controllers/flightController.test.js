import test from 'node:test';
import assert from 'node:assert/strict';
import { flightErrorResponse, getFlights } from './flightController.js';
import axios from 'axios';
import { getReturnFlights, getBookingOptions } from '../services/flightServices.js';

test('flight HTTP failures redact storage/provider details and return a safe retry delay', () => {
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  flightErrorResponse(response, new Error('mongodb://private:fixture-password@private-db.test/secret'), 'Temporarily unavailable.');
  assert.deepEqual(response.body, { success: false, message: 'Temporarily unavailable.' });
  assert.equal(response.code, 502);
  flightErrorResponse(response, { status: 503, providerCode: 'quota_exceeded', retryAfterMs: 30_001, message: 'api_key=private-credential' }, 'Fallback');
  assert.equal(response.headers['Retry-After'], '31');
  assert.equal(response.body.code, 'quota_exceeded');
  assert.match(response.body.message, /temporarily limited/);
  assert.doesNotMatch(JSON.stringify(response.body), /private/);
  flightErrorResponse(response, { status: 410, message: 'private storage detail' }, 'Fallback');
  assert.match(response.body.message, /selection expired/);
  assert.doesNotMatch(JSON.stringify(response.body), /private/);
});
test('invalid search journeys are rejected before any provider call', async () => {
  const valid = { origin: 'DEL', destination: 'BLR', date: '2099-01-01' };
  for (const query of [
    { ...valid, origin: 'Delhi', destination: 'New Delhi (DEL)' },
    { ...valid, date: '2099-02-31' }, { ...valid, date: '2020-01-01' },
    { ...valid, adults: '0' }, { ...valid, adults: '1.5' }, { ...valid, children: '9' }, { ...valid, infants: '2' },
    { ...valid, tripType: 'round-trip', returnDate: '2098-12-31' }, { ...valid, travelClass: '7' },
    { tripType: 'multi-city', legs: JSON.stringify([{ from: 'DEL', to: 'BOM', date: valid.date }, { from: 'BLR', to: 'MAA', date: valid.date }]) },
  ]) {
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await getFlights({ query }, res); assert.equal(res.code, 400, JSON.stringify(query));
  }
});

test('round-trip and multi-city continuation retains every leg, ticket total and booking handoff with controlled provider fixtures', async (context) => {
  const previous = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = 'controlled-continuation-test-key';
  const sent = [];
  context.mock.method(axios, 'get', async (url, { params }) => {
    sent.push(params);
    if (params.booking_token) return { data: { search_parameters: { currency: 'INR' }, booking_options: [{ together: { book_with: 'QA airline', price: 25000, booking_request: { url: 'https://www.google.com/travel/clk', post_data: 'qa=controlled' } } }] } };
    const multi = params.type === 3;
    const next = Boolean(params.departure_token);
    const from = next ? 'DEL' : 'BOM'; const to = next ? multi ? 'BLR' : 'BOM' : 'DEL';
    const date = next ? '2099-03-05' : '2099-03-01';
    return { data: { search_parameters: { currency: 'INR' }, best_flights: [{
      price: next ? 25000 : 12000, total_duration: 120,
      ...(next ? { booking_token: 'controlled-booking-token' } : { departure_token: 'controlled-departure-token' }),
      flights: [{ airline: 'Controlled fixture', flight_number: next ? 'QA 102' : 'QA 101', duration: 120, departure_airport: { id: from, time: `${date} 09:00` }, arrival_airport: { id: to, time: `${date} 11:00` } }],
    }] } };
  });
  try {
    for (const tripType of ['round-trip', 'multi-city']) {
      const query = { origin: 'BOM', destination: tripType === 'multi-city' ? 'BLR' : 'DEL', date: '2099-03-01', returnDate: '2099-03-05', tripType, legs: JSON.stringify([{ from: 'BOM', to: 'DEL', date: '2099-03-01' }, { from: 'DEL', to: 'BLR', date: '2099-03-05' }]) };
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await getFlights({ query }, res); assert.equal(res.code, 200);
      const [complete] = await getReturnFlights(res.body.data[0].departureRef);
      assert.equal(sent.at(-1).departure_token, 'controlled-departure-token');
      const legs = tripType === 'multi-city' ? complete.journeyLegs : complete.roundTripLegs;
      assert.deepEqual(legs.map(leg => [leg.from, leg.to]), [['BOM', 'DEL'], ['DEL', tripType === 'multi-city' ? 'BLR' : 'BOM']]);
      assert.equal(complete.price, 25000, 'the final provider ticket total is not added to earlier previews');
      assert.equal(complete.from, 'BOM'); assert.equal(complete.to, tripType === 'multi-city' ? 'BLR' : 'DEL');
      assert.ok(complete.trackRef); assert.ok(complete.bookingRef);
      assert.equal(complete.departure_token, undefined); assert.equal(complete.booking_token, undefined);
      const [booking] = await getBookingOptions(complete.bookingRef);
      assert.equal(booking.bookingUrl, 'https://www.google.com/travel/clk'); assert.equal(booking.bookingPostData, 'qa=controlled');
    }
  } finally { if (previous === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = previous; }
});

test('valid one-way, round-trip and multi-city requests preserve the provider route, travelers and cabin contract', async (context) => {
  const previous = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = 'controlled-unit-test-key';
  const sent = [];
  context.mock.method(axios, 'get', async (url, { params }) => {
    assert.equal(url, 'https://serpapi.com/search.json'); sent.push(params);
    const first = params.type === 3 ? JSON.parse(params.multi_city_json)[0] : { departure_id: params.departure_id, arrival_id: params.arrival_id, date: params.outbound_date };
    return { data: { search_parameters: { currency: 'INR' }, search_metadata: { processed_at: new Date().toISOString() }, best_flights: [{ price: 12345, flights: [{ airline: 'Controlled fixture', flight_number: 'QA 100', departure_airport: { id: first.departure_id, time: `${first.date} 09:00` }, arrival_airport: { id: first.arrival_id, time: `${first.date} 11:00` } }] }] } };
  });
  try {
    for (const tripType of ['one-way', 'round-trip', 'multi-city']) {
      const query = { origin: 'BOM', destination: tripType === 'multi-city' ? 'BLR' : 'DEL', date: '2099-02-01', tripType, returnDate: '2099-02-05', adults: '2', children: '1', infants: '1', travelClass: '3', legs: JSON.stringify([{ from: 'BOM', to: 'DEL', date: '2099-02-01' }, { from: 'DEL', to: 'BLR', date: '2099-02-03' }]) };
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await getFlights({ query }, res); assert.equal(res.code, 200); assert.equal(res.body.data[0].from, 'BOM'); assert.equal(res.body.data[0].to, 'DEL');
      const p = sent.at(-1); assert.equal(p.engine, 'google_flights'); assert.equal(p.api_key, 'controlled-unit-test-key');
      assert.equal(p.adults, 2); assert.equal(p.children, 1); assert.equal(p.infants_on_lap, 1); assert.equal(p.travel_class, 3);
      assert.equal(p.currency, 'INR'); assert.equal(p.hl, 'en'); assert.equal(p.gl, 'in');
      assert.equal(res.body.data[0].price, 12345);
      assert.equal(JSON.stringify(res.body).includes('controlled-unit-test-key'), false);
      assert.equal(p.type, { 'one-way': 2, 'round-trip': 1, 'multi-city': 3 }[tripType]);
      if (tripType === 'round-trip') assert.equal(p.return_date, query.returnDate);
      if (tripType === 'multi-city') assert.deepEqual(JSON.parse(p.multi_city_json), [{ departure_id: 'BOM', arrival_id: 'DEL', date: query.date }, { departure_id: 'DEL', arrival_id: 'BLR', date: '2099-02-03' }]);
    }
  } finally { if (previous === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = previous; }
});
