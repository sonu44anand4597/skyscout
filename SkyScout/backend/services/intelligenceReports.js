import { createHash } from 'node:crypto';
import IntelligenceReport from '../models/IntelligenceReport.js';

export function reportIdentity(flight, kind = 'fare', extra = '') {
  const itinerary = { userId: String(flight.userId), trackedFlightId: String(flight._id), origin: flight.origin, destination: flight.destination, departureDate: flight.departureDate, returnDate: flight.returnDate, tripType: flight.tripType, airline: flight.airline, flightNumber: flight.flightNumber, departureAt: flight.departureAt, currency: flight.currency, travelClass: flight.travelClass, adults: flight.adults, children: flight.children, infants: flight.infants,
    segments: (flight.segments || []).map(segmentIdentity),
    journeyLegs: (flight.journeyLegs || []).map(legIdentity), roundTripLegs: (flight.roundTripLegs || []).map(legIdentity), kind, extra: typeof extra === 'string' ? extra.trim().replace(/\s+/g, ' ').toLowerCase() : extra };
  return { key: createHash('sha256').update(JSON.stringify(itinerary)).digest('hex'), itinerary };
}

function segmentIdentity(segment) { return { flightNumber: segment.flightNumber, airline: segment.airline, origin: segment.origin?.code, destination: segment.destination?.code, departureAt: segment.origin?.time, arrivalAt: segment.destination?.time }; }
function legIdentity(leg) { return { from: leg.from, to: leg.to, date: leg.date, departureAt: leg.departureAt || leg.departure, arrivalAt: leg.arrivalAt || leg.arrival, segments: (leg.segments || []).map(segmentIdentity) }; }

// Google Search grounding prohibits report caching without additional permission.
// Enable only under an agreement permitting storage; independent provider reports can use this store.
export const canStoreGrounding = () => process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED === 'true';
export async function readReport(key, now = new Date()) { return canStoreGrounding() ? IntelligenceReport.findOne({ key, purgeAt: { $gt: now } }).lean() : null; }
export async function recordReportAttempt(key, result) {
  if (!canStoreGrounding()) return;
  await IntelligenceReport.updateOne({ key }, { $set: { lastAttempt: { status: result.status, at: result.checkedAt || new Date(), diagnostics: result.diagnostics } } });
}
export async function writeReport(identity, flight, report, now = new Date()) {
  if (!canStoreGrounding()) return false;
  if (!['grounded_result', 'no_qualifying_event'].includes(report?.status) || !Array.isArray(report.events) || typeof report.searchSuggestionsHtml !== 'string' || !report.searchSuggestionsHtml.trim()) return false;
  const checkedAt = new Date(report.checkedAt || now);
  if (!Number.isFinite(checkedAt.getTime())) return false;
  await IntelligenceReport.updateOne({ key: identity.key }, { $set: { userId: flight.userId, trackedFlightId: flight._id, itinerary: identity.itinerary, report, checkedAt, expiresAt: new Date(checkedAt.getTime() + 6 * 3600000), purgeAt: new Date(checkedAt.getTime() + 7 * 86400000), lastAttempt: { status: report.status, at: now } } }, { upsert: true });
  return true;
}
