import { createHash } from "node:crypto";
import mongoose from "mongoose";
import TrackedFlight from "../models/TrackedFlight.js";
import PriceObservation from "../models/PriceObservation.js";
import Notification from "../models/Notification.js";
import DisruptionPrediction from "../models/DisruptionPrediction.js";
import FareIntelligenceAnalysis from "../models/FareIntelligenceAnalysis.js";
import { createNotification } from "../services/notificationService.js";
import { getDelayPrediction } from "../services/predictionService.js";
import { getRouteWeather } from "../services/weatherService.js";
import { getTrackedFlightSelection } from "../services/flightServices.js";
import { resolveDestination } from "../services/destinationResolver.js";
import { getDestinationIntelligence } from "../services/destinationIntelligenceService.js";
import { getFareIntelligence } from "../services/fareIntelligenceService.js";
import { getDestinationJourney } from "../services/destinationJourney.js";
import { getFareMarket } from "../services/fareMarket.js";
import IntelligenceReport from "../models/IntelligenceReport.js";
import { destinationArrival } from '../services/routingService.js';
import { pagination, pageResults } from '../services/pagination.js';
import { logServiceError } from '../services/safeLogging.js';
import { airportDate, scheduleInstant } from '../services/airportTime.js';

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

export async function listTrackedFlights(req, res, next) {
  const page = pagination(req.query);
  if (!page) return res.status(400).json({ success: false, message: 'Invalid pagination cursor or limit (1–100).' });
  try {
    const [records, total, activeCount] = await Promise.all([
      TrackedFlight.find({ userId: req.userId, ...page.filter }).sort({ _id: -1 }).limit(page.limit + 1).lean(),
      TrackedFlight.countDocuments({ userId: req.userId }), TrackedFlight.countDocuments({ userId: req.userId, status: 'active' }),
    ]);
    const result = pageResults(records, page.limit, total);
    const flights = result.data;
    const latestPredictions = flights.length ? await DisruptionPrediction.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.userId), trackedFlightId: { $in: flights.map((flight) => flight._id) } } },
      { $sort: { generatedAt: -1 } },
      { $group: { _id: "$trackedFlightId", prediction: { $first: "$$ROOT" } } },
    ]) : [];
    const predictionByFlight = new Map(latestPredictions.map((entry) => [String(entry._id), entry.prediction]));
    return res.json({ success: true, ...result, activeCount, data: flights.map((flight) => ({ ...flight, latestPrediction: predictionByFlight.get(String(flight._id)) || null })) });
  } catch (error) { return next(error); }
}

export async function getTrackedFlight(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Tracked flight not found.' });
  try {
    const flight = await TrackedFlight.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!flight) return res.status(404).json({ success: false, message: 'Tracked flight not found.' });
    const latestPrediction = await DisruptionPrediction.findOne({ trackedFlightId: flight._id, userId: req.userId }).sort({ generatedAt: -1 }).lean();
    return res.json({ success: true, data: { ...flight, latestPrediction } });
  } catch (error) { return next(error); }
}

export async function createTrackedFlight(req, res, next) {
  const requestBody = req.body || {};
  if (typeof requestBody.trackRef !== "string" || !requestBody.trackRef) return res.status(400).json({ success: false, message: "Choose a current flight result before tracking it." });
  let selection;
  try { selection = await getTrackedFlightSelection(requestBody.trackRef); }
  catch (error) {
    if (error.status === 410) return res.status(410).json({ success: false, message: 'This flight selection expired. Search again before tracking it.' });
    return next(error);
  }
  // Fare, route, schedule and itinerary details come from the server's search
  // result snapshot; only the user's optional target price is accepted here.
  const body = { ...selection.flight, ...selection.context, targetPrice: requestBody.targetPrice };
  const origin = String(body.from || body.origin || "").toUpperCase();
  const destination = String(body.to || body.destination || "").toUpperCase();
  const departureAt = typeof body.departureAt === "string" ? body.departureAt : null;
  const departureDate = String(body.departureDate || departureAt?.slice(0, 10) || "");
  const tripType = ["round-trip", "multi-city"].includes(body.tripType) ? body.tripType : "one-way";
  const returnDate = tripType === "round-trip" ? String(body.returnDate || "") : null;
  const roundTripLegs = tripType === "round-trip" && Array.isArray(body.roundTripLegs) ? body.roundTripLegs : [];
  const journeyLegs = tripType === "multi-city" && Array.isArray(body.journeyLegs) ? body.journeyLegs : [];
  const price = Number(body.price);
  const currency = String(body.currency || "").toUpperCase();
  const observedAt = body.quoteObservedAt && Number.isFinite(Date.parse(body.quoteObservedAt)) ? new Date(body.quoteObservedAt) : null;
  if (!observedAt || observedAt.getTime() > Date.now() + 60_000) return res.status(400).json({ success: false, message: 'This flight quote has no verifiable observation time. Search again before tracking it.' });
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination || !validDate(departureDate) || (tripType === "round-trip" && (!validDate(returnDate) || returnDate <= departureDate || roundTripLegs.length !== 2)) || (tripType === "multi-city" && (journeyLegs.length < 2 || journeyLegs.length > 4 || journeyLegs[0]?.from !== origin || journeyLegs.at(-1)?.to !== destination || journeyLegs.some((leg, index) => !/^[A-Z]{3}$/.test(leg.from || "") || !/^[A-Z]{3}$/.test(leg.to || "") || !validDate(leg.date) || leg.from === leg.to || (index > 0 && (journeyLegs[index - 1].to !== leg.from || journeyLegs[index - 1].date > leg.date))))) || !Number.isFinite(price) || price < 1 || !/^[A-Z]{3}$/.test(currency) || !Array.isArray(body.segments) || body.segments.length < 1 || body.segments.length > 32) {
    return res.status(400).json({ success: false, message: "The flight details are incomplete or invalid." });
  }
  const targetPrice = body.targetPrice == null || body.targetPrice === "" ? null : Number(body.targetPrice);
  const timezone = resolveDestination(origin)?.timezone;
  const departureInstant = scheduleInstant(departureAt, timezone);
  if (departureDate < airportDate(new Date(), timezone || 'UTC') || (departureInstant && departureInstant.getTime() <= Date.now())) return res.status(400).json({ success: false, message: 'This itinerary has departed. Search again for an upcoming flight.' });
  if (targetPrice !== null && (!Number.isFinite(targetPrice) || targetPrice < 1)) return res.status(400).json({ success: false, message: "Target price must be a positive amount." });
  const adults = Number(body.adults ?? 1);
  const children = Number(body.children ?? 0);
  const infants = Number(body.infants ?? 0);
  const travelClass = Number(body.travelClass ?? 1);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9 || !Number.isInteger(children) || children < 0 || children > 8 || adults + children > 9 || !Number.isInteger(infants) || infants < 0 || infants > adults || ![1, 2, 3, 4].includes(travelClass)) return res.status(400).json({ success: false, message: "Passenger or cabin details are invalid." });

  const identity = [tripType, body.flightNumber || "", body.airline || "", origin, destination, departureDate, returnDate || "", departureAt || "", ...journeyLegs.map((leg) => `${leg.from}-${leg.to}-${leg.date}-${leg.flightNumber || ""}`), ...roundTripLegs.map((leg) => leg.flightNumber || ""), ...body.segments.map((segment) => segment.flightNumber || "")].join("|");
  const fingerprint = createHash("sha256").update([identity, currency, travelClass, adults, children, infants].join("|")).digest("hex");
  let session;
  try {
    session = await mongoose.startSession();
    let flight;
    await session.withTransaction(async () => {
      [flight] = await TrackedFlight.create([{ userId: req.userId, fingerprint, origin, destination, departureDate, returnDate, tripType, roundTripLegs, journeyLegs, departureAt, airline: body.outboundAirline || body.airline || null, flightNumber: body.outboundFlightNumber || body.flightNumber || null, segments: body.segments, adults, children, infants, travelClass, initialPrice: price, currentPrice: price, quoteObservedAt: observedAt, currency, targetPrice, nextCheckAt: new Date(Date.now() + 6 * 60 * 60 * 1000) }], { session });
      const quoteKey = createHash('sha256').update(`${req.userId}:${flight._id}:${observedAt.toISOString()}:${price}:${currency}`).digest('hex');
      await PriceObservation.create([{ userId: req.userId, trackedFlightId: flight._id, price, currency, observedAt, quoteKey }], { session });
    });
    return res.status(201).json({ success: true, data: flight });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "This flight is already in your watchlist." });
    return next(error);
  } finally {
    await session?.endSession();
  }
}

export async function updateTrackedFlight(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Tracked flight not found." });
  const updates = {};
  if (req.body?.targetPrice !== undefined) {
    const value = req.body.targetPrice === null || req.body.targetPrice === "" ? null : Number(req.body.targetPrice);
    if (value !== null && (!Number.isFinite(value) || value < 1)) return res.status(400).json({ success: false, message: "Target price must be a positive amount." });
    updates.targetPrice = value;
  }
  if (req.body?.status !== undefined) {
    if (!["active", "paused"].includes(req.body.status)) return res.status(400).json({ success: false, message: "Status must be active or paused." });
    updates.status = req.body.status;
    updates.checkLeaseUntil = null;
    updates.checkLeaseOwner = null;
    if (updates.status === "active") { updates.nextCheckAt = new Date(); updates.checkFailures = 0; }
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: "No supported changes were supplied." });
  try {
    const flight = await TrackedFlight.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { $set: updates }, { returnDocument: "after", runValidators: true });
    if (!flight) return res.status(404).json({ success: false, message: "Tracked flight not found." });
    return res.json({ success: true, data: flight });
  } catch (error) { return next(error); }
}

export async function refreshTrackedFlight(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Tracked flight not found.' });
  try {
    const flight = await TrackedFlight.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!flight) return res.status(404).json({ success: false, message: 'Tracked flight not found.' });
    const now = new Date();
    const timezone = resolveDestination(flight.origin)?.timezone;
    const departure = scheduleInstant(flight.departureAt, timezone);
    if (flight.status !== 'active' || flight.departureDate < airportDate(now, timezone || 'UTC') || (departure && departure <= now)) return res.status(409).json({ success: false, message: 'Only active, upcoming flights can be refreshed. Resume monitoring first if it is paused.' });
    const queued = await TrackedFlight.findOneAndUpdate({ _id: flight._id, userId: req.userId, status: 'active', $or: [{ checkLeaseUntil: null }, { checkLeaseUntil: { $lte: now } }] }, { $set: { nextCheckAt: now, checkFailures: 0 } }, { returnDocument: 'after' }).lean();
    if (!queued) return res.status(409).json({ success: false, message: 'A price check is already running or monitoring has changed. Refresh the dashboard shortly.' });
    return res.status(202).json({ success: true, data: queued, message: 'Price check queued. Your fare will update after a verified quote is available.' });
  } catch (error) { return next(error); }
}

export async function deleteTrackedFlight(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Tracked flight not found." });
  let session;
  try {
    session = await mongoose.startSession();
    let flight;
    await session.withTransaction(async () => {
      flight = await TrackedFlight.findOneAndDelete({ _id: req.params.id, userId: req.userId }, { session });
      if (!flight) return;
      // MongoDB does not support parallel operations on a transaction session.
      for (const Model of [PriceObservation, Notification, DisruptionPrediction, FareIntelligenceAnalysis, IntelligenceReport]) {
        await Model.deleteMany({ trackedFlightId: flight._id, userId: req.userId }, { session });
      }
    });
    if (!flight) return res.status(404).json({ success: false, message: "Tracked flight not found." });
    return res.json({ success: true });
  } catch (error) { return next(error); }
  finally { await session?.endSession(); }
}

export async function flightHistory(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Tracked flight not found." });
  try {
    const flight = await TrackedFlight.exists({ _id: req.params.id, userId: req.userId });
    if (!flight) return res.status(404).json({ success: false, message: "Tracked flight not found." });
    const observations = await PriceObservation.find({ trackedFlightId: req.params.id, userId: req.userId }).sort({ observedAt: -1 }).limit(500).lean();
    observations.reverse();
    return res.json({ success: true, data: observations });
  } catch (error) { return next(error); }
}

export async function flightFareIntelligence(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Tracked flight not found." });
  try {
    const flight = await TrackedFlight.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!flight) return res.status(404).json({ success: false, message: "Tracked flight not found." });
    const data = await getFareIntelligence(flight, { research: req.method === "POST", mode: req.query?.mode === "assumption" ? "assumption" : "observed", market: ["normal", "upward", "downward"].includes(req.query?.market) ? req.query.market : "normal" });
    return res.json({ success: true, ...data });
  } catch (error) { return next(error); }
}

export async function flightFareMarket(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Tracked flight not found.' });
  try {
    const flight = await TrackedFlight.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!flight) return res.status(404).json({ success: false, message: 'Tracked flight not found.' });
    return res.json({ success: true, market: await getFareMarket(flight) });
  } catch (error) { return next(error); }
}

export async function flightPrediction(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Tracked flight not found." });
  try {
    const flight = await TrackedFlight.findOne({ _id: req.params.id, userId: req.userId });
    if (!flight) return res.status(404).json({ success: false, message: "Tracked flight not found." });
    const result = await getDelayPrediction(flight);
    return res.json({ success: true, ...result });
  } catch (error) { return next(error); }
}

export async function flightWeather(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Tracked flight not found." });
  try {
    const flight = await TrackedFlight.findOne({ _id: req.params.id, userId: req.userId }).select("origin destination").lean();
    if (!flight) return res.status(404).json({ success: false, message: "Tracked flight not found." });
    return res.json({ success: true, ...(await getRouteWeather(flight.origin, flight.destination)) });
  } catch (error) { return next(error); }
}

export async function flightDestinationIntelligence(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Tracked flight not found." });
  try {
    const flight = await TrackedFlight.findOne({ _id: req.params.id, userId: req.userId }).select("userId origin destination departureDate returnDate tripType airline flightNumber departureAt currency travelClass adults children infants segments roundTripLegs journeyLegs").lean();
    if (!flight) return res.status(404).json({ success: false, message: "Tracked flight not found." });
    const arrival = destinationArrival(flight);
    const destination = resolveDestination(arrival.airportCode);
    if (!destination) return res.json({ success: true, available: false, message: "Destination intelligence is unavailable for this airport code.", events: [] });
    const [cityResult, journeyResult] = await Promise.allSettled([
      getDestinationIntelligence(destination),
      req.query?.finalDestination ? getDestinationJourney(destination, req.query.finalDestination, arrival.arrivalAt, { flight }) : Promise.resolve({ status: "destination_required", message: "Enter a final destination for road routing and grounded journey research." }),
    ]);
    const cityReports = cityResult.status === 'fulfilled' ? cityResult.value : { available: false, events: [], message: 'City report provider failed; journey results are independent.' };
    const journey = journeyResult.status === 'fulfilled' ? journeyResult.value : { status: 'provider_unavailable', message: 'Journey providers failed; city reports remain available.' };
    return res.json({ success: true, ...cityReports, journey });
  } catch (error) {
    logServiceError('destination_intelligence_request_failed', error);
    return res.json({ success: true, available: false, message: "Destination intelligence is temporarily unavailable.", events: [] });
  }
}

export async function listNotifications(req, res, next) {
  const page = pagination(req.query);
  if (!page) return res.status(400).json({ success: false, message: 'Invalid pagination cursor or limit (1–100).' });
  try {
    const [data, total, unreadCount] = await Promise.all([
      Notification.find({ userId: req.userId, ...page.filter }).sort({ _id: -1 }).limit(page.limit + 1).lean(),
      Notification.countDocuments({ userId: req.userId }), Notification.countDocuments({ userId: req.userId, read: false }),
    ]);
    return res.json({ success: true, ...pageResults(data, page.limit, total), unreadCount });
  } catch (error) { return next(error); }
}

export async function markNotificationsRead(req, res, next) {
  try {
    if (!req.params.id || req.params.id === "all") await Notification.updateMany({ userId: req.userId, read: false }, { $set: { read: true } });
    else if (mongoose.isValidObjectId(req.params.id)) await Notification.updateOne({ _id: req.params.id, userId: req.userId }, { $set: { read: true } });
    return res.json({ success: true });
  } catch (error) { return next(error); }
}

export async function checkTargetNotification(flight, currentPrice) {
  if (flight.targetPrice == null || currentPrice > flight.targetPrice) return;
  const { format } = new Intl.NumberFormat("en-IN", { style: "currency", currency: flight.currency, maximumFractionDigits: 0 });
  await createNotification({ userId: flight.userId, trackedFlightId: flight._id, type: "TARGET_REACHED", title: "Your target fare is available", message: `${flight.origin} to ${flight.destination} is now ${format(currentPrice)}, at or below your ${format(flight.targetPrice)} target.`, dedupeKey: `target:${flight._id}:${flight.targetPrice}`, metadata: { price: currentPrice, targetPrice: flight.targetPrice, currency: flight.currency } });
}
