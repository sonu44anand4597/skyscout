import { serpApiRequest, invalidProviderResponse } from './serpApi.js';
import { quoteIsFresh } from './quoteFreshness.js';
import { logServiceError } from './safeLogging.js';
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { claimProviderLease, readProviderState, releaseProviderLease, storeProviderState, storeProviderStates, waitForProviderState } from "./providerState.js";

const searchCache = new Map();
const searchesInFlight = new Map();
const SEARCH_CACHE_MS = 5 * 60 * 1000;
const bookingReferences = new Map();
const bookingOptionsCache = new Map();
const departureReferences = new Map();
const trackingReferences = new Map();
const returnOptionsCache = new Map();
const BOOKING_REFERENCE_MS = 60 * 60 * 1000;
const TRACKING_REFERENCE_MS = 60 * 60 * 1000;

function rememberTrackableFlight(flight, context) {
  const trackRef = randomUUID();
  const safeFlight = { ...flight };
  delete safeFlight.bookingRef;
  delete safeFlight.departureRef;
  if (trackingReferences.size >= 2000) trackingReferences.delete(trackingReferences.keys().next().value);
  trackingReferences.set(trackRef, { flight: safeFlight, context: { ...context, quoteObservedAt: flight.quoteObservedAt || context?.quoteObservedAt }, expiresAt: Date.now() + TRACKING_REFERENCE_MS });
  return { ...flight, trackRef };
}

export async function getTrackedFlightSelection(trackRef) {
  const reference = trackingReferences.get(trackRef) || await readProviderState(`track:${trackRef}`);
  if (!reference || reference.expiresAt <= Date.now()) {
    trackingReferences.delete(trackRef);
    const error = new Error("This flight selection expired. Search again to track the current fare.");
    error.status = 410;
    throw error;
  }
  return reference;
}

async function persistFlightReferences(flights) {
  const entries = [];
  for (const flight of flights) {
    for (const [field, prefix, references] of [
      ["trackRef", "track", trackingReferences],
      ["bookingRef", "booking", bookingReferences],
      ["departureRef", "departure", departureReferences],
    ]) {
      const ref = flight[field];
      if (ref && references.has(ref)) {
        const payload = references.get(ref);
        const { expiresAt } = payload;
        entries.push({ key: `${prefix}:${ref}`, payload, expiresAt });
      }
    }
  }
  await storeProviderStates(entries);
}

const airportCodes = {
  delhi: "DEL", mumbai: "BOM", bangalore: "BLR", bengaluru: "BLR",
  kolkata: "CCU", chennai: "MAA", hyderabad: "HYD", pune: "PNQ",
  goa: "GOI", kochi: "COK", ahmedabad: "AMD", jaipur: "JAI",
};

export function getAirportCode(value) {
  const text = String(value || "").trim();
  const match = text.match(/\(([A-Za-z]{3})\)/);
  const code = match?.[1] || airportCodes[text.toLowerCase()] || text;
  return code.toUpperCase();
}

export { searchAirportSuggestions } from './airportSearch.js';

function normalizeSegment(segment) {
  const departure = segment.departure_airport || {};
  const arrival = segment.arrival_airport || {};
  return {
    airline: segment.airline || null,
    airlineLogo: segment.airline_logo || null,
    flightNumber: segment.flight_number || null,
    origin: { code: departure.id || null, name: departure.name || null, time: departure.time || null },
    destination: { code: arrival.id || null, name: arrival.name || null, time: arrival.time || null },
    durationMinutes: Number.isFinite(segment.duration) ? segment.duration : null,
    travelClass: segment.travel_class || null,
    extensions: Array.isArray(segment.extensions) ? segment.extensions : [],
  };
}

export function normalizeFlight(flight, index, currency, continuationContext = {}) {
  const segments = (Array.isArray(flight.flights) ? flight.flights : []).map(normalizeSegment);
  const first = segments[0];
  const last = segments.at(-1);
  const price = Number(flight.price);
  const carbon = flight.carbon_emissions?.this_flight;
  const normalized = {
    id: `${first?.flightNumber || "flight"}-${first?.origin.code || "origin"}-${first?.origin.time || "time"}-${price}-${index}`,
    airline: first?.airline || null,
    airlineLogo: flight.airline_logo || first?.airlineLogo || null,
    flightNumber: first?.flightNumber || null,
    from: first?.origin.code || null,
    fromName: first?.origin.name || null,
    to: last?.destination.code || null,
    toName: last?.destination.name || null,
    departure: first?.origin.time?.slice(-5) || null,
    arrival: last?.destination.time?.slice(-5) || null,
    departureAt: first?.origin.time || null,
    arrivalAt: last?.destination.time || null,
    durationMinutes: Number.isFinite(flight.total_duration) ? flight.total_duration : null,
    stops: Math.max(segments.length - 1, 0),
    stopsLabel: segments.length <= 1 ? "Non-stop" : `${segments.length - 1} stop${segments.length === 2 ? "" : "s"}`,
    price: flight.price != null && Number.isFinite(price) && price > 0 ? price : null,
    currency,
    travelClass: first?.travelClass || null,
    segments,
    layovers: (Array.isArray(flight.layovers) ? flight.layovers : []).map((layover) => ({ code: layover.id || null, name: layover.name || null, durationMinutes: Number.isFinite(layover.duration) ? layover.duration : null, overnight: layover.overnight === true })),
    quoteObservedAt: continuationContext._trackingContext?.quoteObservedAt || null,
    extensions: Array.isArray(flight.extensions) ? flight.extensions : [],
    emissionsGrams: Number.isFinite(carbon) ? carbon : null,
    // Provider booking/departure tokens remain on the server. Do not return them to browser clients.
  };
  if (typeof flight.booking_token === "string" && flight.booking_token.length > 0) {
    const bookingRef = randomUUID();
    if (bookingReferences.size >= 2000) bookingReferences.delete(bookingReferences.keys().next().value);
    bookingReferences.set(bookingRef, { token: flight.booking_token, context: continuationContext, expiresAt: Date.now() + BOOKING_REFERENCE_MS });
    normalized.bookingRef = bookingRef;
  }
  if (typeof flight.departure_token === "string" && flight.departure_token.length > 0) {
    const departureRef = randomUUID();
    if (departureReferences.size >= 2000) departureReferences.delete(departureReferences.keys().next().value);
    departureReferences.set(departureRef, { token: flight.departure_token, outbound: normalized, context: continuationContext, selectedLegs: continuationContext.selectedLegs || [], expiresAt: Date.now() + BOOKING_REFERENCE_MS });
    normalized.departureRef = departureRef;
  }
  return normalized;
}

function toJourneyLeg(flight, index) {
  return {
    legNumber: index + 1,
    from: flight.from,
    to: flight.to,
    date: flight.departureAt?.slice(0, 10) || null,
    departureAt: flight.departureAt,
    arrivalAt: flight.arrivalAt,
    airline: flight.airline,
    flightNumber: flight.flightNumber,
    price: flight.price,
    currency: flight.currency,
    segments: flight.segments,
    stops: flight.stops,
    stopsLabel: flight.stopsLabel,
    durationMinutes: flight.durationMinutes,
  };
}

export async function getReturnFlights(departureRef) {
  const reference = departureReferences.get(departureRef) || await readProviderState(`departure:${departureRef}`);
  if (!reference || reference.expiresAt <= Date.now()) {
    departureReferences.delete(departureRef);
    returnOptionsCache.delete(departureRef);
    const error = new Error("This outbound selection expired. Search again to choose current return flights.");
    error.status = 410;
    throw error;
  }
  const cached = returnOptionsCache.get(departureRef);
  if (cached && cached.expiresAt > Date.now()) return cached.flights;
  const sharedKey = `return:${departureRef}`;
  const sharedCached = await readProviderState(sharedKey);
  if (sharedCached) {
    returnOptionsCache.set(departureRef, sharedCached);
    return sharedCached.flights;
  }
  const apiKey = process.env.SERPAPI_API_KEY;
  try {
    const providerContext = Object.fromEntries(Object.entries(reference.context).filter(([key]) => !key.startsWith("_") && !["multiCityLegs", "selectedLegs"].includes(key)));
    const response = await serpApiRequest({ ...providerContext, engine: "google_flights", departure_token: reference.token, api_key: apiKey });
    const quoteObservedAt = providerObservedAt(response.data);
    const currentContext = { ...reference.context, _trackingContext: { ...reference.context._trackingContext, quoteObservedAt } };
    if (response.data?.error) throw new Error("Provider returned no itinerary.");
    const rawFlights = [...(response.data?.best_flights || []), ...(response.data?.other_flights || [])];
    if (reference.context.type === 3) {
      const selectedLegs = [...reference.selectedLegs, toJourneyLeg(reference.outbound, reference.selectedLegs.length)];
      const nextContext = { ...currentContext, selectedLegs };
      const flights = rawFlights
        .map((flight, index) => normalizeFlight(flight, index, response.data?.search_parameters?.currency || reference.context.currency || "INR", nextContext))
        .filter((flight) => flight.price !== null && flight.segments.length > 0)
        .map((flight) => {
          const journeyLegs = [...selectedLegs, toJourneyLeg(flight, selectedLegs.length)];
          const isComplete = journeyLegs.length >= reference.context.multiCityLegs.length;
          if (!isComplete) return { ...flight, journeyLegs, multiCityComplete: false, multiCityLegCount: reference.context.multiCityLegs.length };
          // Google Flights returns the selected ticket total at this stage.
          // Earlier continuation previews must not be added to that total.
          const totalPrice = flight.price;
          if (flight.departureRef) departureReferences.delete(flight.departureRef);
          delete flight.departureRef;
          return rememberTrackableFlight({
            ...flight,
            id: `multi-${journeyLegs.map((leg) => leg.flightNumber || leg.departureAt).join("-")}`,
            from: journeyLegs[0].from,
            to: journeyLegs.at(-1).to,
            departure: journeyLegs[0].departureAt?.slice(-5) || null,
            arrival: journeyLegs.at(-1).arrivalAt?.slice(-5) || null,
            departureAt: journeyLegs[0].departureAt,
            arrivalAt: journeyLegs.at(-1).arrivalAt,
            airline: journeyLegs[0].airline,
            flightNumber: journeyLegs[0].flightNumber,
            segments: journeyLegs.flatMap((leg) => leg.segments),
            price: totalPrice,
            stops: journeyLegs.reduce((total, leg) => total + leg.stops, 0),
            stopsLabel: `${journeyLegs.length} city legs`,
            durationMinutes: journeyLegs.reduce((total, leg) => total + (leg.durationMinutes || 0), 0),
            journeyLegs,
            multiCityComplete: true,
            multiCityLegCount: journeyLegs.length,
          }, currentContext._trackingContext);
        });
      if (returnOptionsCache.size >= 500) returnOptionsCache.delete(returnOptionsCache.keys().next().value);
      const expiresAt = Math.min(reference.expiresAt, Date.now() + SEARCH_CACHE_MS);
      returnOptionsCache.set(departureRef, { flights, expiresAt });
      await persistFlightReferences(flights);
      await storeProviderState(sharedKey, { flights, expiresAt }, expiresAt);
      return flights;
    }
    const flights = rawFlights
      .map((flight, index) => normalizeFlight(flight, index, response.data?.search_parameters?.currency || reference.context.currency || "INR", currentContext))
      .filter((flight) => flight.price !== null && flight.segments.length > 0)
      .map((flight) => {
        const outbound = reference.outbound;
        return {
          ...flight,
          id: `${outbound.id}-return-${flight.id}`,
          roundTripLegs: [
            { direction: "Outbound", departure: outbound.departureAt, arrival: outbound.arrivalAt, from: outbound.from, fromName: outbound.fromName, to: outbound.to, toName: outbound.toName, airline: outbound.airline, flightNumber: outbound.flightNumber, segments: outbound.segments, stopsLabel: outbound.stopsLabel, durationMinutes: outbound.durationMinutes },
            { direction: "Return", departure: flight.departureAt, arrival: flight.arrivalAt, from: flight.from, fromName: flight.fromName, to: flight.to, toName: flight.toName, airline: flight.airline, flightNumber: flight.flightNumber, segments: flight.segments, stopsLabel: flight.stopsLabel, durationMinutes: flight.durationMinutes },
          ],
          from: outbound.from,
          fromName: outbound.fromName,
          to: outbound.to,
          toName: outbound.toName,
          departure: outbound.departure,
          departureAt: outbound.departureAt,
          outboundFlightNumber: outbound.flightNumber,
          outboundAirline: outbound.airline,
          outboundSegments: outbound.segments,
          returnDepartureAt: flight.departureAt,
          returnFlightNumber: flight.flightNumber,
          returnAirline: flight.airline,
          returnSegments: flight.segments,
          segments: [...outbound.segments, ...flight.segments],
          roundTrip: true,
        };
      })
      .map((flight) => rememberTrackableFlight(flight, currentContext._trackingContext));
    if (returnOptionsCache.size >= 500) returnOptionsCache.delete(returnOptionsCache.keys().next().value);
    const expiresAt = Math.min(reference.expiresAt, Date.now() + SEARCH_CACHE_MS);
    returnOptionsCache.set(departureRef, { flights, expiresAt });
    await persistFlightReferences(flights);
    await storeProviderState(sharedKey, { flights, expiresAt }, expiresAt);
    return flights;
  } catch (cause) {
    if (cause.providerCode) throw cause;
    if (cause.status === 410) throw cause;
    logServiceError('flight_return_options_failed', cause);
    const error = new Error("Return flight options could not be loaded. Please retry.");
    error.status = 502;
    throw error;
  }
}

export function normalizeBookingOptions(data) {
  const options = (data.booking_options || []).flatMap((group) => {
    if (!group || typeof group !== 'object') return [];
    const cityLegs = Object.keys(group).filter((key) => /^flight_\d+$/.test(key)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
    return ['together', 'separate', 'departing', 'returning', ...cityLegs].flatMap((key) => {
      const values = Array.isArray(group[key]) ? group[key] : [group[key]];
      const ticketLabel = key === 'departing' ? 'Separate outbound ticket' : key === 'returning' ? 'Separate return ticket' : /^flight_\d+$/.test(key) ? `Separate city leg ${Number(key.slice(7))} ticket` : null;
      return values.filter((option) => option && typeof option === 'object').map((option) => ({ option, ticketLabel }));
    });
  });
  return options.map(({ option, ticketLabel }) => {
    const request = option.booking_request || {};
    let bookingUrl = null;
    try {
      const parsed = new URL(request.url);
      if (parsed.protocol === 'https:' && (parsed.hostname === 'google.com' || parsed.hostname.endsWith('.google.com'))) bookingUrl = parsed.toString();
    } catch { /* Provider may return a summary without an actionable booking link. */ }
    const localPrice = option.local_prices?.find((item) => item.currency === data.search_parameters?.currency);
    return {
      provider: option.book_with || 'Booking provider',
      isAirline: option.airline === true,
      price: Number.isFinite(Number(localPrice?.price)) ? Number(localPrice.price) : Number.isFinite(Number(option.price)) ? Number(option.price) : null,
      currency: localPrice?.currency || data.search_parameters?.currency || null,
      fareName: [option.option_title, ticketLabel].filter(Boolean).join(' · ') || null,
      extensions: Array.isArray(option.extensions) ? option.extensions : [],
      baggage: Array.isArray(option.baggage_prices) ? option.baggage_prices : [],
      bookingUrl,
      bookingPostData: bookingUrl && typeof request.post_data === 'string' && request.post_data.length <= 12000 ? request.post_data : null,
    };
  });
}

export async function getBookingOptions(bookingRef) {
  const reference = bookingReferences.get(bookingRef) || await readProviderState(`booking:${bookingRef}`);
  if (!reference || reference.expiresAt <= Date.now()) {
    bookingReferences.delete(bookingRef);
    bookingOptionsCache.delete(bookingRef);
    const error = new Error("This booking selection expired. Search again to get current options.");
    error.status = 410;
    throw error;
  }
  const cached = bookingOptionsCache.get(bookingRef);
  if (cached && cached.expiresAt > Date.now()) return cached.options;
  const sharedKey = `booking-options:v2:${bookingRef}`;
  const sharedCached = await readProviderState(sharedKey);
  if (sharedCached) {
    bookingOptionsCache.set(bookingRef, sharedCached);
    return sharedCached.options;
  }
  const apiKey = process.env.SERPAPI_API_KEY;
  try {
    const providerContext = Object.fromEntries(Object.entries(reference.context || {}).filter(([key]) => !key.startsWith("_") && !["multiCityLegs", "selectedLegs"].includes(key)));
    const response = await serpApiRequest({ ...providerContext, engine: "google_flights", booking_token: reference.token, api_key: apiKey });
    const options = normalizeBookingOptions(response.data);
    if (bookingOptionsCache.size >= 500) bookingOptionsCache.delete(bookingOptionsCache.keys().next().value);
    const expiresAt = Math.min(reference.expiresAt, Date.now() + 5 * 60 * 1000);
    bookingOptionsCache.set(bookingRef, { options, expiresAt });
    await storeProviderState(sharedKey, { options, expiresAt }, expiresAt);
    return options;
  } catch (cause) {
    if (cause.providerCode) throw cause;
    logServiceError('flight_booking_options_failed', cause);
    const error = new Error("Booking options could not be loaded. Search again and retry.");
    error.status = 502;
    throw error;
  }
}

export function providerObservedAt(data) {
  const time = data?.search_metadata?.processed_at || data?.search_metadata?.created_at;
  return time && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
}

export async function searchFlights({ origin, destination, date, returnDate, tripType = 'one-way', legs = [], adults = 1, children = 0, infants = 0, travelClass = 1, currency = 'INR', fresh = false }) {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    const error = new Error("Flight search is not configured. Add SERPAPI_API_KEY to the backend environment.");
    error.status = 503;
    error.providerCode = 'not_configured';
    throw error;
  }

  const outbound = getAirportCode(origin);
  const inbound = getAirportCode(destination);
  const multiCityLegs = tripType === "multi-city" ? legs.map((leg) => ({ departure_id: getAirportCode(leg.from), arrival_id: getAirportCode(leg.to), date: leg.date })) : [];
  const params = {
    engine: "google_flights",
    ...(tripType === "multi-city" ? { type: 3, multi_city_json: JSON.stringify(multiCityLegs) } : { departure_id: outbound, arrival_id: inbound, outbound_date: date, type: tripType === "round-trip" ? 1 : 2 }),
    adults,
    children,
    infants_on_lap: infants,
    travel_class: travelClass,
    currency,
    hl: "en",
    gl: "in",
    api_key: apiKey,
    ...(fresh ? { no_cache: true } : {}),
  };
  if (tripType === "round-trip") params.return_date = returnDate;

  const continuationContext = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "api_key"));
  continuationContext._trackingContext = { tripType, departureDate: tripType === "multi-city" ? multiCityLegs[0].date : date, returnDate: tripType === "round-trip" ? returnDate : null, adults, children, infants, travelClass };
  if (tripType === "multi-city") continuationContext.multiCityLegs = multiCityLegs;

  const cacheKey = JSON.stringify({ origin: outbound, destination: inbound, date, returnDate, tripType, legs: multiCityLegs, adults, children, infants, travelClass, currency, fresh });
  const sharedCacheKey = `search:v2:${createHash("sha256").update(cacheKey).digest("hex")}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && (!fresh || quoteIsFresh(cached.result.searchedAt))) return { ...cached.result, cached: true };
  if (cached) searchCache.delete(cacheKey);
  const sharedCached = await readProviderState(sharedCacheKey);
  if (sharedCached && (!fresh || quoteIsFresh(sharedCached.result.searchedAt))) {
    searchCache.set(cacheKey, sharedCached);
    return { ...sharedCached.result, cached: true };
  }

  if (searchesInFlight.has(cacheKey)) return searchesInFlight.get(cacheKey);
  const pending = (async () => {
    const leaseOwner = await claimProviderLease(sharedCacheKey, 75000);
    if (leaseOwner === null) {
      const completed = await waitForProviderState(sharedCacheKey, 42000);
      if (completed) {
        searchCache.set(cacheKey, completed);
        return { ...completed.result, cached: true };
      }
      const error = new Error("A matching flight search is still running. Please retry shortly.");
      error.status = 503;
      throw error;
    }
    try {

  let response;
  try {
    response = await serpApiRequest(params);
  } catch (cause) {
    if (cause.providerCode) throw cause;
    const status = cause.response?.status;
    const providerCode = status === 429 ? 'quota_exceeded' : status === 401 || status === 403 ? 'invalid_key' : cause.code === 'ECONNABORTED' ? 'timeout' : 'provider_unavailable';
    const error = new Error(`SerpApi flight search failed (${providerCode}${status ? `, HTTP ${status}` : ''}).`);
    error.providerCode = providerCode;
    error.providerStatus = status || null;
    error.status = cause.response?.status === 429 ? 503 : 502;
    throw error;
  }
  if (response.data?.error) {
    const message = String(response.data.error).replaceAll(apiKey, '[redacted]').replace(/https?:\/\/\S+/g, '[provider URL]').slice(0, 250);
    const error = new Error(`SerpApi: ${message}`);
    error.providerCode = /limit|quota|credit|run out/i.test(message) ? 'quota_exceeded' : 'invalid_query';
    error.status = 502;
    throw error;
  }

  if (response.data?.search_parameters?.currency && response.data.search_parameters.currency !== currency) throw invalidProviderResponse();
  const searchedAt = providerObservedAt(response.data);
  continuationContext._trackingContext.quoteObservedAt = searchedAt;
  const flights = [
    ...(Array.isArray(response.data?.best_flights) ? response.data.best_flights : []),
    ...(Array.isArray(response.data?.other_flights) ? response.data.other_flights : []),
  ].map((flight, index) => normalizeFlight(flight, index, currency, continuationContext))
    .filter((flight) => flight.price !== null && flight.segments.length > 0)
    .map((flight) => tripType === "multi-city" ? flight : rememberTrackableFlight(flight, continuationContext._trackingContext));

  const result = {
    flights,
    priceInsights: response.data?.price_insights || null,
    searchedAt,
    cached: false,
  };
  const expiresAt = Date.now() + SEARCH_CACHE_MS;
  await persistFlightReferences(flights);
  await storeProviderStates([{ key: sharedCacheKey, payload: { result, expiresAt }, expiresAt }]);
  if (searchCache.size >= 500) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(cacheKey, { result, expiresAt });
  return result;
    } finally {
      try { await releaseProviderLease(sharedCacheKey, leaseOwner); }
      catch (error) { logServiceError('flight_search_lease_release_failed', error); }
    }
  })();
  searchesInFlight.set(cacheKey, pending);
  try { return await pending; }
  finally { searchesInFlight.delete(cacheKey); }
}
