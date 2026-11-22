import test from 'node:test';
import assert from 'node:assert/strict';
import { providerError, retryAfterMilliseconds, serpApiRequest } from './serpApi.js';
import { normalizeFlight, normalizeBookingOptions, providerObservedAt } from './flightServices.js';

test('provider errors are redacted and classify permanent, transient and quota failures', () => {
  const error = providerError({ response: { status: 401, data: { error: 'secret-key https://provider/?api_key=secret-key' } } });
  assert.equal(error.providerCode, 'invalid_key'); assert.equal(error.retryable, false);
  assert.equal(error.message.includes('secret-key'), false);
  assert.equal(providerError({ code: 'ECONNABORTED' }).providerCode, 'timeout');
  assert.equal(providerError({ response: { status: 429, data: { error: 'Monthly quota exceeded' } } }).retryable, false);
  assert.equal(providerError({ response: { status: 502 } }).retryable, true);
  assert.equal(retryAfterMilliseconds('2'), 2000);
  assert.equal(retryAfterMilliseconds('2026-10-28T10:00:05Z', Date.parse('2026-10-28T10:00:00Z')), 5000);
});
test('provider retries transient errors once with bounded jitter and honors long Retry-After without spinning', async () => {
  let calls = 0; const waits = [];
  const result = await serpApiRequest({ engine: 'google_flights' }, { apiKey: 'fixture', request: async () => { calls++; if (calls === 1) throw { response: { status: 503 } }; return { data: { other_flights: [] } }; }, pause: async (ms) => waits.push(ms), random: () => 0 });
  assert.deepEqual(result.data.other_flights, []); assert.equal(calls, 2); assert.deepEqual(waits, [350]);
  calls = 0;
  await assert.rejects(serpApiRequest({ engine: 'google_flights' }, { apiKey: 'fixture', request: async () => { calls++; throw { response: { status: 429, headers: { 'retry-after': '120' } } }; }, pause: async () => assert.fail('must not retry before the specified time') }), (error) => error.retryAfterMs === 120000);
  assert.equal(calls, 1);
});

test('rate-limit retries wait for the shared minimum cooldown even without Retry-After', async () => {
  let calls = 0;
  const waits = [];
  await serpApiRequest({ engine: 'google_flights' }, {
    apiKey: 'rate-limit-fixture', random: () => 0, pause: async (ms) => waits.push(ms),
    request: async () => { if (++calls === 1) throw { response: { status: 429 } }; return { data: { other_flights: [] } }; },
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test('configured retry counts stay capped and always reject after the final failure', async () => {
  for (const [maxAttempts, expected] of [[10, 3], [0, 1], [1.5, 1], [NaN, 2]]) {
    let calls = 0;
    let pauses = 0;
    await assert.rejects(serpApiRequest({ engine: 'google_flights' }, {
      apiKey: 'bounded-attempt-fixture', maxAttempts, random: () => 0,
      pause: async () => pauses++, request: async () => { calls++; throw { response: { status: 503 } }; },
    }), { providerCode: 'provider_unavailable' });
    assert.equal(calls, expected);
    assert.equal(pauses, expected - 1);
  }
});
test('invalid response structures and missing credentials fail explicitly', async () => {
  for (const data of ['<html>broken</html>', { best_flights: {} }]) await assert.rejects(serpApiRequest({}, { apiKey: 'fixture', request: async () => ({ data }) }), { providerCode: 'invalid_response' });
  await assert.rejects(serpApiRequest({}, { apiKey: '' }), { providerCode: 'not_configured' });
});
test('a provider no-results response becomes a clean empty flight result', async () => {
  const response = await serpApiRequest({ engine: 'google_flights' }, { apiKey: 'fixture', request: async () => ({ data: { error: "Google Flights hasn't returned any results for this query" } }) });
  assert.deepEqual(response.data.best_flights, []);
  assert.deepEqual(response.data.other_flights, []);
  assert.equal(response.data.error, undefined);
});

test('cold flight searches have a bounded attempt budget within the browser deadline', async () => {
  const timeouts = [];
  await serpApiRequest({ engine: 'google_flights' }, { apiKey: 'flight-timeout-fixture', random: () => 0, pause: async () => {}, request: async (_url, options) => {
    timeouts.push(options.timeout);
    if (timeouts.length === 1) throw { code: 'ECONNABORTED' };
    return { data: { other_flights: [] } };
  } });
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[0] > 12000, 'allow a cold provider search more than the former 12-second cap');
  assert.ok(timeouts.reduce((sum, value) => sum + value, 0) + 1000 < 45000);
});
test('normalization preserves segment identity and real layovers without turning absent prices into zero', () => {
  const raw = { price: 8200, total_duration: 300, layovers: [{ id: 'BOM', duration: 60 }], flights: [
    { flight_number: 'EX 1', departure_airport: { id: 'DEL', time: '2026-12-01 09:00' }, arrival_airport: { id: 'BOM', time: '2026-12-01 11:00' } },
    { flight_number: 'EX 2', departure_airport: { id: 'BOM', time: '2026-12-01 12:00' }, arrival_airport: { id: 'BLR', time: '2026-12-01 14:00' } },
  ] };
  const flight = normalizeFlight(raw, 0, 'INR');
  assert.equal(flight.from, 'DEL'); assert.equal(flight.to, 'BLR'); assert.equal(flight.stops, 1);
  assert.equal(flight.layovers[0].durationMinutes, 60); assert.equal(flight.durationMinutes, 300);
  assert.equal(normalizeFlight({ ...raw, price: null }, 0, 'INR').price, null);
  assert.equal(providerObservedAt({ search_metadata: { processed_at: '2026-10-28T10:00:00Z' } }), '2026-10-28T10:00:00.000Z');
  assert.equal(providerObservedAt({}), null);
  assert.equal(providerObservedAt({ search_metadata: { processed_at: 'unparseable provider timestamp' } }), null);
});

test('separate round-trip and multi-city booking tickets retain their own safe handoffs and fare labels', () => {
  const ticket = (book_with, price) => ({ book_with, price, booking_request: { url: 'https://www.google.com/travel/clk/f', post_data: 'u=controlled-test' } });
  for (const fields of [{ departing: ticket('Airline A', 5000), returning: ticket('Airline B', 6000) }, { flight_1: ticket('Airline A', 5000), flight_2: ticket('Airline B', 6000) }]) {
    const results = normalizeBookingOptions({ search_parameters: { currency: 'INR' }, booking_options: [{ separate_tickets: true, together: { book_with: 'Airline A, Airline B', price: 11000 }, ...fields }] });
    assert.equal(results.length, 3); assert.equal(results[0].price, 11000); assert.equal(results[0].bookingUrl, null);
    assert.deepEqual(results.slice(1).map(o => o.price), [5000, 6000]);
    assert.ok(results.slice(1).every(o => o.bookingUrl === 'https://www.google.com/travel/clk/f' && o.bookingPostData && o.fareName.startsWith('Separate')));
  }
  const [unsafe] = normalizeBookingOptions({ booking_options: [{ together: { ...ticket('Untrusted', 1), booking_request: { url: 'https://google.com.attacker.test/book', post_data: 'unsafe' } } }] });
  assert.equal(unsafe.bookingUrl, null); assert.equal(unsafe.bookingPostData, null);
});
