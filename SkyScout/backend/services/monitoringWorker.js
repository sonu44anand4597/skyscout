import mongoose from "mongoose";
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import TrackedFlight from "../models/TrackedFlight.js";
import PriceObservation from "../models/PriceObservation.js";
import Notification from '../models/Notification.js';
import { getReturnFlights, searchFlights } from "./flightServices.js";
import { createNotification } from "./notificationService.js";
import { checkTargetNotification } from "../controllers/trackedFlightController.js";
import { getDelayPrediction } from "./predictionService.js";
import { persistOperation } from './operations.js';
import { resolveDestination } from './destinationResolver.js';
import { airportDate, scheduleInstant } from './airportTime.js';
import { quoteIsFresh } from './quoteFreshness.js';
import { logServiceError } from './safeLogging.js';

const HOUR = 60 * 60 * 1000;
const CHECK_INTERVAL = 60 * 1000;
const CHECK_PERIOD = 6 * HOUR;
const MAX_PER_TICK = 4;
let ticking = false;
let workerTimer;

function clearLease(flightId, updates, owner) {
  return TrackedFlight.updateOne({ _id: flightId, ...(owner ? { checkLeaseOwner: owner, checkLeaseUntil: { $gt: new Date() }, status: 'active' } : {}) }, { $set: { ...updates, checkLeaseUntil: null, checkLeaseOwner: null } });
}

export function quoteNotifications(flight, observation) {
  const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: flight.currency, maximumFractionDigits: 0 });
  const notifications = [];
  if (observation.price < flight.currentPrice) notifications.push({ userId: flight.userId, trackedFlightId: flight._id, type: 'PRICE_DROP', title: 'Flight price dropped', message: `${flight.origin} to ${flight.destination} changed from ${amount.format(flight.currentPrice)} to ${amount.format(observation.price)}.`, dedupeKey: `drop:${observation.quoteKey}`, metadata: { previousPrice: flight.currentPrice, price: observation.price, currency: flight.currency, observedAt: observation.observedAt } });
  if (flight.targetPrice != null && observation.price <= flight.targetPrice) notifications.push({ userId: flight.userId, trackedFlightId: flight._id, type: 'TARGET_REACHED', title: 'Your target fare is available', message: `${flight.origin} to ${flight.destination} is now ${amount.format(observation.price)}, at or below your ${amount.format(flight.targetPrice)} target.`, dedupeKey: `target:${flight._id}:${flight.targetPrice}`, metadata: { price: observation.price, targetPrice: flight.targetPrice, currency: flight.currency, observedAt: observation.observedAt } });
  return notifications;
}

export async function commitMonitoredQuote(flight, observation, updates) {
  // A delayed worker must reacquire an expired lease before writing a quote.
  // Checking the owner alone also accepts a lease that nobody has reclaimed yet.
  if (!flight.checkLeaseOwner) return false;
  const session = await mongoose.startSession();
  let committed = false;
  try {
    await session.withTransaction(async () => {
      committed = false;
      const previous = await TrackedFlight.findOneAndUpdate({ _id: flight._id, userId: flight.userId, status: 'active',
        checkLeaseOwner: flight.checkLeaseOwner, checkLeaseUntil: { $gt: new Date() },
        $or: [{ quoteObservedAt: null }, { quoteObservedAt: { $lte: observation.observedAt } }],
      }, { $set: { ...updates, quoteObservedAt: observation.observedAt, checkLeaseUntil: null, checkLeaseOwner: null } }, { session, returnDocument: 'before' }).lean();
      if (!previous) return;
      await PriceObservation.updateOne({ quoteKey: observation.quoteKey }, { $setOnInsert: observation }, { upsert: true, session });
      const notifications = quoteNotifications(previous, observation);
      for (const notification of notifications) await Notification.updateOne({ dedupeKey: notification.dedupeKey }, { $setOnInsert: notification }, { upsert: true, session });
      committed = { notifications };
    });
    return committed;
  } finally { await session.endSession(); }
}

const defaultWorkerDependencies = {
  searchFlights,
  getReturnFlights,
  clearLease,
  recordObservation: (observation) => PriceObservation.updateOne({ quoteKey: observation.quoteKey }, { $setOnInsert: observation }, { upsert: true }),
  commitQuote: commitMonitoredQuote,
  createNotification,
  checkTargetNotification,
  getDelayPrediction,
  logError: logServiceError,
};

export function matchesTrackedFlight(candidate, tracked, expected = null) {
  const identity = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const lastJourneyLeg = candidate.journeyLegs?.at(-1);
  const current = lastJourneyLeg ? { ...candidate, ...lastJourneyLeg } : candidate;
  const route = expected ? { ...expected, departureAt: expected.departureAt || expected.departure } : { from: tracked.origin, to: tracked.destination, date: tracked.departureDate, departureAt: tracked.departureAt, airline: tracked.airline, flightNumber: tracked.flightNumber };
  if (current.from !== route.from || current.to !== route.to) return false;
  const date = current.departureAt?.slice(0, 10);
  if (date !== (route.date || route.departureAt?.slice(0, 10))) return false;
  if (route.flightNumber) {
    if (identity(current.flightNumber) !== identity(route.flightNumber)) return false;
    if (route.airline && identity(current.airline) !== identity(route.airline)) return false;
    const expectedSegments = expected?.segments || (!expected ? tracked.segments : null);
    if (expectedSegments?.length) {
      if (expectedSegments.length !== current.segments?.length) return false;
      return expectedSegments.every((segment, index) => identity(segment.flightNumber) === identity(current.segments[index].flightNumber) && segment.origin?.code === current.segments[index].origin?.code && segment.destination?.code === current.segments[index].destination?.code && segment.origin?.time?.slice(0, 10) === current.segments[index].origin?.time?.slice(0, 10));
    }
    return true;
  }
  if (!route.airline || current.airline !== route.airline) return false;
  if (!route.departureAt || !current.departureAt) return false;
  return Math.abs(Date.parse(current.departureAt) - Date.parse(route.departureAt)) <= 90 * 60 * 1000;
}

export function monitoringRetryDelay(failures) {
  const normalizedFailures = Number.isInteger(failures) && failures >= 0 ? failures : 0;
  return Math.min(2 ** normalizedFailures, 24) * HOUR;
}

export async function processFlight(flight, dependencies = defaultWorkerDependencies) {
  const resolvedDependencies = { ...defaultWorkerDependencies, ...dependencies };
  const {
    searchFlights: search,
    getReturnFlights: getContinuation,
    clearLease: releaseLease,
    recordObservation,
    createNotification: notify,
    checkTargetNotification: evaluateTarget,
    getDelayPrediction: refreshPrediction,
    logError,
  } = resolvedDependencies;
  const release = (updates) => releaseLease(flight._id, updates, flight.checkLeaseOwner);
  try {
    const timezone = resolveDestination(flight.origin)?.timezone;
    const today = airportDate(new Date(), timezone || 'UTC');
    const departureInstant = scheduleInstant(flight.departureAt, timezone);
    if (flight.departureDate < today || (departureInstant && departureInstant.getTime() <= Date.now())) {
      await release({ status: "completed", lastCheckedAt: new Date(), nextCheckAt: null, lastCheckError: null, checkFailures: 0 });
      return;
    }
    const searchArgs = { origin: flight.origin, destination: flight.destination, date: flight.departureDate, returnDate: flight.returnDate, tripType: flight.tripType || "one-way", legs: flight.journeyLegs?.map((leg) => ({ from: leg.from, to: leg.to, date: leg.date })), adults: flight.adults, children: flight.children, infants: flight.infants, travelClass: flight.travelClass, currency: flight.currency };
    const result = await search({ ...searchArgs, fresh: true });
    let match;
    let outbound;
    if (flight.tripType === "multi-city") {
      const expectedLegs = flight.journeyLegs || [];
      let selected = result.flights.find((candidate) => matchesTrackedFlight(candidate, flight, expectedLegs[0]));
      for (let index = 1; selected && index < expectedLegs.length; index += 1) {
        if (!selected.departureRef) { selected = null; break; }
        const nextLegOptions = await getContinuation(selected.departureRef);
        selected = nextLegOptions.find((candidate) => matchesTrackedFlight(candidate, flight, expectedLegs[index]));
      }
      match = selected;
      outbound = result.flights.find((candidate) => matchesTrackedFlight(candidate, flight, expectedLegs[0]));
    } else {
      outbound = result.flights.find((candidate) => matchesTrackedFlight(candidate, flight, flight.tripType === "round-trip" ? { ...flight.roundTripLegs?.[0], date: flight.departureDate } : null));
      match = outbound;
    }
    if (outbound && flight.tripType === "round-trip") {
      const returnOptions = await getContinuation(outbound.departureRef);
      const expected = flight.roundTripLegs?.[1];
      match = returnOptions.find((candidate) => {
        return expected && matchesTrackedFlight({ from: expected.from, to: expected.to, departureAt: candidate.returnDepartureAt, flightNumber: candidate.returnFlightNumber, airline: candidate.returnAirline, segments: candidate.returnSegments }, flight, { ...expected, date: flight.returnDate });
      });
    }
    const checkedAt = new Date();
    if (!match) {
      const released = await release({ lastCheckedAt: checkedAt, nextCheckAt: new Date(Date.now() + CHECK_PERIOD), lastCheckError: "No sufficiently confident flight match was found.", checkFailures: 0 });
      if (released?.matchedCount === 0) return;
      await notify({ userId: flight.userId, trackedFlightId: flight._id, type: "CHECK_UNRESOLVED", title: "Flight price check needs review", message: `SkyScout could not confidently match ${flight.origin} to ${flight.destination}. Your tracked price was not changed.`, dedupeKey: `unresolved:${flight._id}:${flight.departureDate}:${checkedAt.toISOString().slice(0, 13)}` });
      return;
    }

    const oldPrice = flight.currentPrice;
    // Record confirmed unchanged quotes too; day-wise fare audits need actual
    // later observations, not only dates on which the price moved.
    if (!Number.isFinite(match.price) || match.price <= 0 || (match.currency && match.currency !== flight.currency)) throw new Error('Provider returned an invalid fare or a different currency.');
    const quoteTime = match.quoteObservedAt || result.searchedAt;
    if (!quoteTime || !Number.isFinite(Date.parse(quoteTime))) {
      await release({ lastCheckedAt: checkedAt, nextCheckAt: new Date(Date.now() + CHECK_PERIOD), lastCheckError: 'Provider did not supply a verifiable quote timestamp; the latest verified fare was preserved.', checkFailures: 0 });
      return;
    }
    const observedAt = new Date(quoteTime);
    if (!quoteIsFresh(observedAt, checkedAt)) {
      await release({ lastCheckedAt: checkedAt, nextCheckAt: new Date(Date.now() + CHECK_PERIOD), lastCheckError: 'Provider returned a stale quote; the latest verified fare was preserved.' });
      return;
    }
    if (flight.quoteObservedAt && observedAt < new Date(flight.quoteObservedAt)) {
      await release({ lastCheckedAt: checkedAt, nextCheckAt: new Date(Date.now() + CHECK_PERIOD), lastCheckError: 'Provider returned an older quote; the latest verified fare was preserved.' });
      return;
    }
    const quoteKey = createHash('sha256').update(`${flight.userId}:${flight._id}:${observedAt.toISOString()}:${match.price}:${flight.currency}`).digest('hex');
    const nextCheckAt = new Date(Date.now() + CHECK_PERIOD);
    const observation = { userId: flight.userId, trackedFlightId: flight._id, price: match.price, currency: flight.currency, observedAt, quoteKey };
    const updates = { currentPrice: match.price, ...(match.roundTripLegs ? { roundTripLegs: match.roundTripLegs, segments: match.segments } : {}), ...(match.journeyLegs ? { journeyLegs: match.journeyLegs, segments: match.segments } : {}), lastCheckedAt: checkedAt, nextCheckAt, lastCheckError: null, checkFailures: 0 };
    let committedNotifications;
    if (resolvedDependencies.commitQuote) {
      const commit = await resolvedDependencies.commitQuote(flight, observation, updates);
      if (!commit) return;
      committedNotifications = commit.notifications;
    } else { await recordObservation(observation); await release(updates); }

    if (committedNotifications) {
      for (const notification of committedNotifications) await notify(notification);
    } else {
    if (match.price < oldPrice) {
      const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: flight.currency, maximumFractionDigits: 0 });
      await notify({ userId: flight.userId, trackedFlightId: flight._id, type: "PRICE_DROP", title: "Flight price dropped", message: `${flight.origin} to ${flight.destination} changed from ${amount.format(oldPrice)} to ${amount.format(match.price)}.`, dedupeKey: `drop:${quoteKey}`, metadata: { previousPrice: oldPrice, price: match.price, currency: flight.currency, observedAt } });
    }
    await evaluateTarget(flight, match.price);
    }
    try {
      await refreshPrediction(flight);
    } catch (predictionError) {
      logError('monitoring_prediction_failed', predictionError);
    }
  } catch (error) {
    const failures = flight.checkFailures || 0;
    const retryDelay = monitoringRetryDelay(failures);
    const stopped = ['invalid_key', 'invalid_query', 'not_configured', 'invalid_response'].includes(error.providerCode) || failures >= 5;
    await release({ ...(stopped ? { status: 'unresolved' } : {}), checkFailures: failures + 1, nextCheckAt: stopped ? null : new Date(Date.now() + Math.max(retryDelay, error.retryAfterMs || 0)), lastCheckError: `Price check failed (${error.providerCode || 'provider_or_storage_error'}${error.providerStatus ? `; HTTP ${error.providerStatus}` : ''}); ${stopped ? 'monitoring needs review before resuming' : 'retry scheduled'}.`, lastCheckedAt: new Date() });
    logError('monitored_quote_failed', error);
  }
}

export async function runMonitoringTick() {
  if (ticking || mongoose.connection.readyState !== 1) return;
  ticking = true;
  try {
    for (let index = 0; index < MAX_PER_TICK; index += 1) {
      const now = new Date();
      const flight = await TrackedFlight.findOneAndUpdate({ status: "active", nextCheckAt: { $lte: now }, $or: [{ checkLeaseUntil: null }, { checkLeaseUntil: { $lt: now } }] }, { $set: { checkLeaseOwner: randomUUID(), checkLeaseUntil: new Date(Date.now() + 10 * 60 * 1000) } }, { returnDocument: "after", sort: { nextCheckAt: 1 } });
      if (!flight) break;
      await processFlight(flight);
    }
    await persistOperation('monitoring', 'ok');
  } catch (error) {
    await persistOperation('monitoring', 'storage_error').catch(() => {});
    logServiceError('monitoring_tick_failed', error);
  } finally {
    ticking = false;
  }
}

export function startMonitoringWorker() {
  if (!workerTimer) {
    workerTimer = setInterval(runMonitoringTick, CHECK_INTERVAL);
    workerTimer.unref?.();
    void runMonitoringTick();
  }
  return workerTimer;
}

export async function stopMonitoringWorker() {
  clearInterval(workerTimer);
  workerTimer = undefined;
  while (ticking) await new Promise((resolve) => setTimeout(resolve, 50));
}
