// Fixed provider endpoint; neither addresses nor source URLs become fetch URLs.
const FIELD_MASK = ['routes.description', 'routes.distanceMeters', 'routes.duration', 'routes.staticDuration', 'routes.polyline.encodedPolyline', 'routes.legs.startLocation', 'routes.legs.endLocation', 'routes.legs.steps.navigationInstruction.instructions', 'geocodingResults'].join(',');
const duration = (value) => typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value) ? Number(value.slice(0, -1)) : null;
const minutes = (seconds) => seconds == null ? null : `${Math.ceil(seconds / 60)} min`;
import { scheduleInstant } from './airportTime.js';

export function destinationArrival(flight) {
  if (flight.tripType === 'round-trip' && flight.roundTripLegs?.[0]) {
    const leg = flight.roundTripLegs[0];
    return { airportCode: leg.to || flight.destination, arrivalAt: leg.arrival || leg.arrivalAt || leg.segments?.at(-1)?.destination?.time || null };
  }
  const leg = flight.tripType === 'multi-city' ? flight.journeyLegs?.at(-1) : null;
  return { airportCode: leg?.to || flight.destination, arrivalAt: leg?.arrivalAt || flight.segments?.at(-1)?.destination?.time || null };
}

export async function routesBetween(airport, finalDestination, arrivalAt, fetcher = fetch) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is missing. Enable and configure Google Maps Routes API with billing to retrieve road routes.' };
  const place = typeof finalDestination === 'string' ? finalDestination.trim() : '';
  if (place.length < 3 || place.length > 120 || [...place].some((character) => character.codePointAt(0) < 32)) return { status: 'invalid_destination', message: 'Enter a destination between 3 and 120 characters.' };
  const address = place.includes(',') ? place : `${place}, ${airport.city}, ${airport.country || airport.countryCode || ''}`;
  const body = { origin: { address: `${airport.airportName} (${airport.airportCode}), ${airport.city}, ${airport.country || airport.countryCode || ''}` }, destination: { address }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', computeAlternativeRoutes: true, languageCode: 'en', units: 'METRIC' };
  if (airport.location) body.origin = { location: { latLng: airport.location } };
  const time = scheduleInstant(arrivalAt, airport.timezone || (airport.countryCode === 'IN' ? 'Asia/Kolkata' : null))?.getTime();
  if (Number.isFinite(time) && time > Date.now()) body.departureTime = new Date(time).toISOString();
  const checkedAt = new Date().toISOString();
  const response = await fetcher('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    const providerStatus = data.error?.status || response.status;
    return { status: ['PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(providerStatus) ? 'configuration_error' : providerStatus === 'RESOURCE_EXHAUSTED' ? 'quota_exceeded' : 'provider_unavailable', providerStatus,
      message: `Google Maps Routes returned ${providerStatus}. Check Routes API enablement, credential restrictions, quota and billing.` };
  }
  const geocoded = data.geocodingResults?.destination;
  if (geocoded?.partialMatch) return { status: 'ambiguous_destination', message: 'Google could only partially match this destination. Enter a fuller address.' };
  const routes = (Array.isArray(data.routes) ? data.routes : []).filter((route) => Number.isFinite(route.distanceMeters) && route.distanceMeters > 0 && duration(route.duration) != null).map((route) => {
    const durationSeconds = duration(route.duration);
    const staticDurationSeconds = duration(route.staticDuration);
    return { summary: route.description || null, distanceMeters: route.distanceMeters, distanceText: `${(route.distanceMeters / 1000).toFixed(1)} km`, durationSeconds,
      staticDurationSeconds, durationText: minutes(staticDurationSeconds ?? durationSeconds), trafficDurationText: minutes(durationSeconds),
      encodedPolyline: route.polyline?.encodedPolyline || null, startLocation: route.legs?.[0]?.startLocation?.latLng || null, endLocation: route.legs?.at(-1)?.endLocation?.latLng || null,
      steps: (route.legs || []).flatMap((leg) => (leg.steps || []).map((step) => step.navigationInstruction?.instructions).filter((step) => typeof step === 'string')).slice(0, 80),
    };
  });
  if (!routes.length) return { status: 'no_route', message: 'Google Maps returned no supported driving route for this destination.' };
  return { status: 'available', provider: 'Google Maps Routes API', checkedAt, departureTime: body.departureTime || checkedAt,
    timingBasis: body.departureTime ? 'Estimated road departure at the flight arrival time; airport exit time is not included.' : 'Estimated road departure now; the flight arrival timezone or future time was unavailable.',
    estimateType: body.departureTime ? 'scheduled_traffic_estimate' : 'current_traffic_estimate',
    geocodedDestination: { placeId: geocoded?.placeId || null, location: routes[0].endLocation, requestedAddress: address }, routes };
}
