// Bounded LIVE provider contract checks. Temporary records are cleaned up.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import connectDB from '../config/database.js';
import { readProviderState } from '../services/providerState.js';
import { serpApiRequest } from '../services/serpApi.js';
import { processFlight } from '../services/monitoringWorker.js';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import Notification from '../models/Notification.js';
import DisruptionPrediction from '../models/DisruptionPrediction.js';

const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api';
const evidence = { executedAt: new Date().toISOString(), source: 'LIVE SerpApi Google Flights via actual API, with MongoDB tracking' };
let cookie; let userId;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
async function request(route, method = 'GET', body) {
  const response = await fetch(`${api}${route}`, { method, headers: { 'X-SkyScout-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const payload = await response.json(); assert.equal(response.ok, true, `${method} ${route.split('?')[0]}: ${payload.message}`);
  return { response, payload };
}
try {
  await connectDB();
  const account = await request('/auth/register', 'POST', { name: 'Provider journey verification', email: `journey-${randomUUID()}@example.test`, password: randomUUID() });
  userId = account.payload.user.id; cookie = account.response.headers.getSetCookie()[0].split(';')[0];
  for (const tripType of ['round-trip', 'multi-city']) {
    const params = new URLSearchParams({ origin: 'DEL', destination: tripType === 'multi-city' ? 'BOM' : 'BLR', date: day(28), tripType, returnDate: day(32), adults: '1', children: '0', infants: '0', travelClass: '1', currency: 'INR' });
    if (tripType === 'multi-city') params.set('legs', JSON.stringify([{ from: 'DEL', to: 'BLR', date: day(28) }, { from: 'BLR', to: 'BOM', date: day(30) }]));
    const first = (await request(`/flights/search?${params}`)).payload;
    const outbound = first.data.find((flight) => flight.departureRef);
    assert.ok(outbound, `${tripType}: a real continuation token is required`);
    const next = (await request(`/flights/return-options/${outbound.departureRef}`, 'POST')).payload.data;
    assert.ok(next.length, `${tripType}: live provider returned no next-leg options`);
    const selected = next[0];
    if (tripType === 'multi-city') {
      assert.equal(selected.multiCityComplete, true); assert.equal(selected.journeyLegs.length, 2);
      // Independently read the provider ticket total, without the app's journey
      // aggregation, to catch accidental addition of earlier fare previews.
      const ref = await readProviderState(`departure:${outbound.departureRef}`);
      const context = Object.fromEntries(Object.entries(ref.context).filter(([key]) => !key.startsWith('_') && !['multiCityLegs', 'selectedLegs'].includes(key)));
      const raw = await serpApiRequest({ ...context, departure_token: ref.token });
      const rawOffers = [...(raw.data.best_flights || []), ...(raw.data.other_flights || [])];
      const last = selected.journeyLegs.at(-1);
      const match = rawOffers.find((offer) => offer.flights?.[0]?.flight_number === last.flightNumber && offer.flights?.[0]?.departure_airport?.time === last.departureAt);
      assert.ok(match); assert.equal(selected.price, match.price);
      evidence.multiCityProviderTotalMatches = true;
    } else assert.equal(selected.roundTripLegs.length, 2);
    const tracked = (await request('/tracked-flights', 'POST', { trackRef: selected.trackRef })).payload.data;
    const saved = await TrackedFlight.findById(tracked._id).lean();
    assert.equal(saved.initialPrice, selected.price); assert.equal(saved.tripType, tripType); assert.ok(saved.quoteObservedAt);
    const before = await PriceObservation.countDocuments({ trackedFlightId: saved._id });
    await processFlight(saved);
    const checked = await TrackedFlight.findById(saved._id).lean();
    assert.equal(checked.lastCheckError, null);
    assert.ok(Number.isFinite(checked.currentPrice) && checked.currentPrice > 0);
    assert.ok(new Date(checked.quoteObservedAt) >= new Date(saved.quoteObservedAt));
    const observations = await PriceObservation.find({ trackedFlightId: saved._id }).sort({ observedAt: -1 }).lean();
    assert.ok(observations.length >= before && observations.length <= before + 1);
    assert.equal(observations[0].price, checked.currentPrice);
    assert.equal(new Date(observations[0].observedAt).getTime(), new Date(checked.quoteObservedAt).getTime());
    assert.equal(new Set(observations.map((item) => item.quoteKey)).size, observations.length);
    let bookings = null;
    if (selected.bookingRef) bookings = (await request(`/flights/booking-options/${selected.bookingRef}`, 'POST')).payload.data.length;
    evidence[tripType] = { firstLegOffers: first.data.length, nextLegOffers: next.length, fare: selected.price, checkedFare: checked.currentPrice, currency: selected.currency, quoteObservedAt: saved.quoteObservedAt, checkedQuoteObservedAt: checked.quoteObservedAt, trackingPersisted: true, workerMatched: true, observationsBefore: before, observationsAfter: observations.length, duplicateObservationAvoided: true, bookingOptions: bookings };
  }
  console.log(JSON.stringify(evidence));
} catch (error) { evidence.failure = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  if (userId) { for (const Model of [PriceObservation, Notification, DisruptionPrediction, TrackedFlight, AuthSession]) await Model.deleteMany({ userId }); await User.deleteOne({ _id: userId }); }
  await mongoose.disconnect();
  await mkdir('../docs/qa/production-2026-10-28', { recursive: true });
  await writeFile('../docs/qa/production-2026-10-28/provider-journeys.json', JSON.stringify(evidence, null, 2));
}
