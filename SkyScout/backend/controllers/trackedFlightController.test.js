import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { createTrackedFlight } from './trackedFlightController.js';
import { searchFlights } from '../services/flightServices.js';

test('tracking refuses genuine-shaped provider results with unverifiable timestamps or unsupported passenger totals', async () => {
  const originalRequest = axios.get;
  const originalKey = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = 'controlled-test-credential';
  try {
    let metadata;
    axios.get = async (_url, { params }) => ({ data: {
      search_metadata: metadata, search_parameters: { currency: 'INR' },
      other_flights: [{ price: 4000, flights: [{ airline: 'Controlled test fixture', flight_number: 'QA 321', departure_airport: { id: 'BOM', time: `${params.outbound_date} 09:00` }, arrival_airport: { id: 'DEL', time: `${params.outbound_date} 11:00` } }] }],
    } });
    for (const [index, supplied] of [undefined, { processed_at: 'broken' }, { processed_at: '2099-01-01T00:00:00Z' }, { processed_at: new Date().toISOString() }].entries()) {
      metadata = supplied;
      const flights = await searchFlights({ origin: 'BOM', destination: 'DEL', date: `2099-10-${10 + index}`, ...(index === 3 ? { adults: 9, children: 1 } : {}) });
      let status;
      let payload;
      await createTrackedFlight({ body: { trackRef: flights.flights[0].trackRef }, userId: 'fixture-owner' }, {
        status(value) { status = value; return this; }, json(value) { payload = value; return this; },
      }, (error) => { throw error; });
      assert.equal(status, 400);
      assert.match(payload.message, index === 3 ? /Passenger or cabin/ : /verifiable observation time/);
    }
  } finally {
    axios.get = originalRequest;
    if (originalKey === undefined) delete process.env.SERPAPI_API_KEY;
    else process.env.SERPAPI_API_KEY = originalKey;
  }
});

test('an expired itinerary cannot be tracked from a still-valid search selection', async () => {
  const original = axios.get;
  const originalKey = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = 'expired-tracking-fixture';
  try {
    axios.get = async () => ({ data: { search_metadata: { processed_at: new Date().toISOString() }, other_flights: [{ price: 4000, flights: [{ airline: 'Controlled fixture', flight_number: 'QA200', departure_airport: { id: 'DEL', time: '2020-01-01 09:00' }, arrival_airport: { id: 'BLR', time: '2020-01-01 11:00' } }] }] } });
    const result = await searchFlights({ origin: 'DEL', destination: 'BLR', date: '2020-01-01' });
    let status; let payload;
    await createTrackedFlight({ body: { trackRef: result.flights[0].trackRef } }, { status(value) { status = value; return this; }, json(value) { payload = value; } }, (error) => { throw error; });
    assert.equal(status, 400); assert.match(payload.message, /has departed/);
  } finally { axios.get = original; if (originalKey === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = originalKey; }
});
