// Bounded live smoke: genuine fares, one grounding call and public weather.
// Only the loopback QA database may receive these temporary test records.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import connectDB, { closeDatabase } from '../config/database.js';
import { searchAirportSuggestions, searchFlights, getReturnFlights, getBookingOptions } from '../services/flightServices.js';
import { processFlight } from '../services/monitoringWorker.js';
import { discoverFareEvents } from '../services/fareEvents.js';
import { getRouteWeather } from '../services/weatherService.js';
import { routesBetween } from '../services/routingService.js';
import { resolveDestination } from '../services/destinationResolver.js';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import Notification from '../models/Notification.js';
import DisruptionPrediction from '../models/DisruptionPrediction.js';
import FareIntelligenceAnalysis from '../models/FareIntelligenceAnalysis.js';

const output = process.env.QA_OUTPUT_DIR || '../docs/qa/readiness-2026-11-14';
const evidence = { executedAt: new Date().toISOString(), source: 'LIVE SerpApi, Gemini Google Search grounding and AviationWeather.gov; temporary QA account on loopback MongoDB', searches: [], airports: [] };
const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api';
const date = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
let userId;
const summary = result => ({ count: result.flights.length, observedAt: result.searchedAt, currencies: [...new Set(result.flights.map(f => f.currency))], cached: result.cached });
try {
  assert.match(process.env.MONGODB_URI || '', /^mongodb:\/\/127\.0\.0\.1:27018\/skyscout_readiness_/);
  await connectDB(); assert.equal(mongoose.connection.readyState, 1);
  for (const [query, code] of [['Delhi', 'DEL'], ['Mumbai', 'BOM'], ['Bengaluru', 'BLR'], ['Hyderabad', 'HYD'], ['Chennai', 'MAA'], ['Kolkata', 'CCU'], ['JFK', 'JFK'], ['London', 'LHR']]) {
    const result = await searchAirportSuggestions(query);
    assert.ok(result.items.some(item => item.iata === code)); evidence.airports.push({ query, expected: code, source: result.source });
  }
  const oneWay = await searchFlights({ origin: 'DEL', destination: 'BLR', date: date(28) });
  evidence.searches.push({ tripType: 'one-way', ...summary(oneWay) }); assert.ok(oneWay.flights.length > 0);
  const roundTrip = await searchFlights({ origin: 'BOM', destination: 'DEL', date: date(29), returnDate: date(35), tripType: 'round-trip', adults: 2, children: 1, travelClass: 3 });
  evidence.searches.push({ tripType: 'round-trip-outbound', adults: 2, children: 1, travelClass: 3, ...summary(roundTrip) });
  const outbound = roundTrip.flights.find(f => f.departureRef); assert.ok(outbound);
  const returns = await getReturnFlights(outbound.departureRef); assert.ok(returns.length > 0); assert.equal(returns[0].roundTripLegs.length, 2);
  evidence.searches.push({ tripType: 'round-trip-complete', count: returns.length, preservedLegs: 2, currency: returns[0].currency });
  try {
    const multi = await searchFlights({ origin: 'DEL', destination: 'BOM', date: date(30), tripType: 'multi-city', legs: [{ from: 'DEL', to: 'BLR', date: date(30) }, { from: 'BLR', to: 'BOM', date: date(32) }] });
    evidence.searches.push({ tripType: 'multi-city-outbound', ...summary(multi), continuationTokens: multi.flights.filter(f => f.departureRef).length });
    const multiFirst = multi.flights.find(f => f.departureRef); assert.ok(multiFirst, 'Multi-city provider did not return a continuation token');
    const complete = await getReturnFlights(multiFirst.departureRef);
    evidence.searches.push({ tripType: 'multi-city-complete', count: complete.length, preservedLegs: complete[0]?.journeyLegs?.length, currency: complete[0]?.currency });
    assert.ok(complete[0]?.multiCityComplete, 'Multi-city response did not complete the requested legs');
  } catch (error) { evidence.multiCityFailure = error.providerCode || error.message; }
  const bookable = returns.find(f => f.bookingRef) || oneWay.flights.find(f => f.bookingRef);
  const options = bookable ? await getBookingOptions(bookable.bookingRef) : [];
  evidence.booking = { providerOptions: options.length, handoffLinks: options.filter(option => option.bookingUrl).length, purchaseSubmitted: false };

  const registration = await fetch(`${api}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SkyScout-Request': '1' }, body: JSON.stringify({ name: 'Live provider QA', email: `live-${randomUUID()}@example.test`, password: randomUUID() }) });
  assert.equal(registration.status, 201); userId = (await registration.json()).user.id;
  const cookie = registration.headers.getSetCookie()[0].split(';')[0];
  const selected = oneWay.flights.find(f => f.trackRef && f.quoteObservedAt); assert.ok(selected);
  const tracking = await fetch(`${api}/tracked-flights`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SkyScout-Request': '1', Cookie: cookie }, body: JSON.stringify({ trackRef: selected.trackRef }) });
  assert.equal(tracking.status, 201); const tracked = (await tracking.json()).data;
  const owned = await TrackedFlight.findOneAndUpdate({ _id: tracked._id }, { $set: { checkLeaseOwner: randomUUID(), checkLeaseUntil: new Date(Date.now() + 600000) } }, { returnDocument: 'after' }).lean();
  await processFlight(owned, { getDelayPrediction: async () => ({ available: false }) });
  const refreshed = await TrackedFlight.findById(owned._id).lean();
  evidence.monitoring = { selectedItinerarySaved: true, leaseReleased: !refreshed.checkLeaseOwner, checkedAt: refreshed.lastCheckedAt, quoteObservedAt: refreshed.quoteObservedAt, observations: await PriceObservation.countDocuments({ trackedFlightId: owned._id }), lastCheckError: refreshed.lastCheckError };
  assert.equal(evidence.monitoring.leaseReleased, true); assert.equal(refreshed.lastCheckError, null);

  const research = await discoverFareEvents(refreshed, date(0), { timeoutMs: 30000 });
  evidence.grounding = { status: research.status, events: research.events?.length || 0, diagnostics: research.diagnostics, providerStatus: research.providerStatus || null, storageEnabled: process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED === 'true' };
  const weather = await getRouteWeather('DEL', 'BLR');
  evidence.weather = weather.airports.map(airport => ({ airport: airport.airport, station: airport.station, available: airport.available, observedAt: airport.observation?.observedAt, validFrom: airport.forecast?.validFrom, validTo: airport.forecast?.validTo }));
  assert.ok(weather.available);
  const routing = await routesBetween(resolveDestination('BLR'), 'Koramangala', `${date(28)} 13:00`);
  evidence.routing = { status: routing.status, liveRouteVerified: routing.status === 'available' };
} catch (error) { evidence.failure = error.providerCode || error.name; console.error(JSON.stringify({ failure: evidence.failure })); process.exitCode = 1; }
finally {
  if (userId) { for (const Model of [PriceObservation, Notification, DisruptionPrediction, FareIntelligenceAnalysis, TrackedFlight, AuthSession]) await Model.deleteMany({ userId }); await User.deleteOne({ _id: userId }); }
  await closeDatabase(); await mkdir(output, { recursive: true }); await writeFile(`${output}/provider-smoke.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
}
