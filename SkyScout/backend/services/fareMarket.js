import { createHash } from 'node:crypto';
import { searchFlights } from './flightServices.js';
import { matchesTrackedFlight, quoteNotifications } from './monitoringWorker.js';
import PriceObservation from '../models/PriceObservation.js';
import TrackedFlight from '../models/TrackedFlight.js';
import mongoose from 'mongoose';
import { quoteIsFresh } from './quoteFreshness.js';
import { readProviderState, storeProviderState } from './providerState.js';
import { airportDate, scheduleInstant } from './airportTime.js';
import { resolveDestination } from './destinationResolver.js';
import { logServiceError } from './safeLogging.js';
import Notification from '../models/Notification.js';
import { createNotification } from './notificationService.js';

const pending = new Map();
export async function getFareMarket(flight, { search = searchFlights, record = recordMarketQuote, now = new Date(), read = readProviderState, store = storeProviderState } = {}) {
  if (flight.tripType !== 'one-way') return { status: 'unsupported_itinerary', message: 'Comparable offers currently support one-way flights; combined totals are not compared.' };
  const timezone = resolveDestination(flight.origin)?.timezone;
  const departure = scheduleInstant(flight.departureAt, timezone);
  if (flight.departureDate < airportDate(now, timezone || 'UTC') || (departure && departure <= now)) return { status: 'departure_reached', message: 'This itinerary has departed.' };
  const key = `fare-market:${flight.userId}:${flight._id}`;
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const saved = await read(key);
    if (saved?.expiresAt > now.getTime()) return { ...saved, cached: true };
    try {
      const context = { origin: flight.origin, destination: flight.destination, date: flight.departureDate, tripType: 'one-way', adults: flight.adults ?? 1, children: flight.children ?? 0, infants: flight.infants ?? 0, travelClass: flight.travelClass ?? 1, currency: flight.currency };
      let result = await search(context);
      if (!quoteIsFresh(result.searchedAt, now)) result = await search({ ...context, fresh: true });
      const quotes = result.flights.filter((offer) => offer.from === flight.origin && offer.to === flight.destination && offer.departureAt?.slice(0, 10) === flight.departureDate && offer.currency === flight.currency && Number.isFinite(offer.price) && offer.price > 0);
      const match = quotes.find((offer) => matchesTrackedFlight(offer, flight));
      const freshQuote = quoteIsFresh(result.searchedAt, now);
      if (match && freshQuote) await record(flight, match, result.searchedAt);
      const baseline = match?.price ?? flight.currentPrice;
      const value = { status: 'available', source: 'SerpApi Google Flights', checkedAt: now.toISOString(), quotedAt: result.searchedAt, cached: result.cached, currency: flight.currency, stale: !freshQuote,
        matchedFare: match?.price || null, matchStatus: match ? 'exact_itinerary' : 'selected_flight_not_returned',
        context: { route: `${flight.origin}–${flight.destination}`, departureDate: flight.departureDate, adults: flight.adults, children: flight.children, infants: flight.infants, travelClass: flight.travelClass },
        offers: quotes.slice(0, 24).map((offer, index) => ({ id: offer.id, label: `${offer.airline || 'Airline'} ${offer.departure || ''} (${index + 1})`, airline: offer.airline, flightNumber: offer.flightNumber, price: offer.price, difference: offer.price - baseline, departure: offer.departure, arrival: offer.arrival, stops: offer.stops, durationMinutes: offer.durationMinutes, selected: offer === match })),
        expiresAt: now.getTime() + 5 * 60000 };
      await store(key, value, now.getTime() + 86400000);
      return value;
    } catch (error) {
      const failure = { status: error.providerCode || 'provider_unavailable', httpStatus: error.providerStatus || error.status || null, message: 'Comparable fares could not be refreshed. The last verified fare was preserved.', checkedAt: now.toISOString() };
      logServiceError('fare_market_refresh_failed', error);
      return saved ? { ...saved, stale: true, lastAttempt: failure } : failure;
    }
  })().finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

export async function recordMarketQuote(flight, offer, quotedAt) {
  const observedAt = new Date(quotedAt);
  if (!Number.isFinite(observedAt.getTime())) return;
  const quoteKey = createHash('sha256').update(`${flight.userId}:${flight._id}:${observedAt.toISOString()}:${offer.price}:${offer.currency}`).digest('hex');
  const session = await mongoose.startSession();
  let notifications = [];
  try {
    await session.withTransaction(async () => {
      notifications = [];
      const previous = await TrackedFlight.findOneAndUpdate({ _id: flight._id, userId: flight.userId, $or: [{ quoteObservedAt: { $lte: observedAt } }, { quoteObservedAt: null }] }, { $set: { currentPrice: offer.price, quoteObservedAt: observedAt, lastCheckedAt: new Date(), lastCheckError: null } }, { session, returnDocument: 'before' }).lean();
      if (!previous) return;
      await PriceObservation.updateOne({ quoteKey }, { $setOnInsert: { quoteKey, userId: flight.userId, trackedFlightId: flight._id, price: offer.price, currency: offer.currency, observedAt, source: 'serpapi_google_flights' } }, { upsert: true, session });
      notifications = quoteNotifications(previous, { price: offer.price, quoteKey, observedAt });
      for (const notification of notifications) await Notification.updateOne({ dedupeKey: notification.dedupeKey }, { $setOnInsert: notification }, { upsert: true, session });
    });
  } finally { await session.endSession(); }
  for (const notification of notifications) await createNotification(notification);
}
