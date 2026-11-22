import { getAirportCode, getBookingOptions, getReturnFlights, searchAirportSuggestions, searchFlights } from "../services/flightServices.js";
import { resolveDestination } from '../services/destinationResolver.js';
import { airportDate } from '../services/airportTime.js';
import { logServiceError } from '../services/safeLogging.js';

export function flightErrorResponse(res, error, fallback) {
  const retryAfterMs = Number(error.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  const code = error.providerCode;
  const messages = {
    invalid_key: 'Flight search is temporarily unavailable because the provider could not authenticate.',
    not_configured: 'Flight search is not configured on this server.',
    quota_exceeded: 'Flight search is temporarily limited by the data provider. Please try again later.',
    rate_limited: 'Flight search is temporarily limited by the data provider. Please try again later.',
    concurrency_limited: 'Flight search is busy. Please retry shortly.',
    timeout: 'The flight provider took too long to respond. Please retry.',
    provider_unavailable: 'The flight provider is temporarily unavailable. Please retry.',
    invalid_response: 'The flight provider returned an invalid response. Please retry.',
    invalid_query: 'The flight provider could not process this itinerary. Please check the search details.',
  };
  const safeCode = Object.hasOwn(messages, code) ? code : undefined;
  const message = safeCode ? messages[safeCode] : error.status === 410 ? 'This flight selection expired. Search again to continue.' : fallback;
  return res.status(error.status || 502).json({ success: false, ...(safeCode ? { code: safeCode } : {}), message });
}

export async function getAirports(req, res) {
  const query = String(req.query.q || "").trim();
  if (query.length < 2 || query.length > 80) return res.status(400).json({ success: false, message: "Enter between 2 and 80 characters for an airport search." });
  try {
    const { items, ...airportSearch } = await searchAirportSuggestions(query);
    return res.json({ success: true, data: items, airportSearch });
  }
  catch (error) { logServiceError('airport_search_failed', error); return flightErrorResponse(res, error, 'Airport search is temporarily unavailable. Please retry.'); }
}

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

export async function getFlights(req, res) {
  let { origin, destination, date } = req.query;
  const returnDate = String(req.query.returnDate || "");
  const tripType = String(req.query.tripType || "one-way");
  const adults = Number(req.query.adults ?? 1);
  const children = Number(req.query.children ?? 0);
  const infants = Number(req.query.infants ?? 0);
  const travelClass = Number(req.query.travelClass ?? 1);
  const currency = String(req.query.currency ?? "INR").toUpperCase();
  let legs = [];

  if (!["one-way", "round-trip", "multi-city"].includes(tripType)) return res.status(400).json({ success: false, message: "Trip type must be one-way, round-trip or multi-city." });
  if (tripType === "multi-city") {
    try {
      const suppliedLegs = JSON.parse(String(req.query.legs || ""));
      if (!Array.isArray(suppliedLegs) || suppliedLegs.length < 2 || suppliedLegs.length > 4) throw new Error("invalid legs");
      legs = suppliedLegs.map((leg) => ({ from: getAirportCode(leg.from), to: getAirportCode(leg.to), date: String(leg.date || "") }));
    } catch {
      return res.status(400).json({ success: false, message: "Add between two and four valid city legs." });
    }
    const isValidJourney = legs.every((leg, index) => /^[A-Z]{3}$/.test(leg.from) && /^[A-Z]{3}$/.test(leg.to) && leg.from !== leg.to && validDate(leg.date) && (!index || (legs[index - 1].to === leg.from && legs[index - 1].date <= leg.date)));
    if (!isValidJourney) return res.status(400).json({ success: false, message: "Each city leg needs valid airports and dates, and each leg must continue from the previous arrival." });
    origin = legs[0].from;
    destination = legs.at(-1).to;
    date = legs[0].date;
  } else if (!origin || !destination || !date) {
    return res.status(400).json({ success: false, message: "Origin, destination and departure date are required." });
  }
  if (tripType !== "multi-city" && String(origin).trim().toLowerCase() === String(destination).trim().toLowerCase()) {
    return res.status(400).json({ success: false, message: "Origin and destination must be different." });
  }
  if (![origin, destination].every((airport) => /^[A-Z]{3}$/.test(getAirportCode(airport)))) {
    return res.status(400).json({ success: false, message: "Choose an airport from the suggestions so its airport code is valid." });
  }
  if (tripType !== 'multi-city' && getAirportCode(origin) === getAirportCode(destination)) return res.status(400).json({ success: false, message: 'Origin and destination must be different.' });
  if (!validDate(date)) {
    return res.status(400).json({ success: false, message: "Enter a valid departure date." });
  }
  const todayAt = (code) => airportDate(new Date(), resolveDestination(getAirportCode(code))?.timezone || 'Etc/GMT+12');
  if (date < todayAt(origin) || legs.some((leg) => leg.date < todayAt(leg.from))) return res.status(400).json({ success: false, message: 'Choose a departure date today or later at the origin airport.' });
  if (tripType === "round-trip" && (!validDate(returnDate) || returnDate <= date)) return res.status(400).json({ success: false, message: "Choose a valid return date after the departure date." });
  if (!Number.isInteger(adults) || adults < 1 || adults > 9 || !Number.isInteger(children) || children < 0 || children > 8 || !Number.isInteger(infants) || infants < 0 || infants > adults || adults + children > 9) {
    return res.status(400).json({ success: false, message: "Passenger count is outside the supported range." });
  }
  if (![1, 2, 3, 4].includes(travelClass) || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ success: false, message: "Travel class or currency is invalid." });
  }

  try {
    const result = await searchFlights({ origin, destination, date, returnDate, tripType, legs, adults, children, infants, travelClass, currency });
    return res.status(200).json({ success: true, total: result.flights.length, data: result.flights, priceInsights: result.priceInsights, searchedAt: result.searchedAt, cached: result.cached });
  } catch (error) {
    logServiceError('flight_search_failed', error);
    return flightErrorResponse(res, error, 'Flight search is temporarily unavailable. Please retry.');
  }
}

export async function getFlightBookingOptions(req, res) {
  try {
    const options = await getBookingOptions(req.params.bookingRef);
    return res.json({ success: true, data: options });
  } catch (error) {
    logServiceError('flight_booking_options_failed', error);
    return flightErrorResponse(res, error, 'Booking options are temporarily unavailable. Please retry.');
  }
}

export async function getFlightReturnOptions(req, res) {
  try {
    const flights = await getReturnFlights(req.params.departureRef);
    return res.json({ success: true, total: flights.length, data: flights });
  } catch (error) {
    logServiceError('flight_return_options_failed', error);
    return flightErrorResponse(res, error, 'Return flight options are temporarily unavailable. Please retry.');
  }
}
