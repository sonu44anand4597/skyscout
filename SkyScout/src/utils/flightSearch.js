export const airportText = (airport) => airport ? `${airport.city} (${airport.iata || airport.code})` : '';
export const airportSelection = (airport) => ({ text: airportText(airport), airport });
export const editedAirport = (text) => ({ text, airport: null });
export const swapAirports = (from, to) => ({ from: to, to: from });
const code = (selection) => selection?.airport?.iata || selection?.airport?.code;
const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const todayAt = (selection, now) => new Intl.DateTimeFormat('en-CA', { timeZone: selection?.airport?.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function buildFlightSearch({ from, to, departure, returnDate, tripType, multiLegs, travellers, travelClass }, now = new Date()) {
  const failure = (error) => ({ error });
  const { adults, children, infants } = travellers;
  if (![1, 2, 3, 4].includes(travelClass) || !Number.isInteger(adults) || adults < 1 || adults > 9 || !Number.isInteger(children) || children < 0 || adults + children > 9 || !Number.isInteger(infants) || infants < 0 || infants > adults) return failure('Choose up to 9 adults and children, with at most one lap infant per adult, and a valid cabin.');
  const validateLeg = (leg) => {
    if (![code(leg.from), code(leg.to)].every((value) => /^[A-Z]{3}$/.test(value || ''))) return 'Select a valid departure and destination airport from the suggestions.';
    if (code(leg.from) === code(leg.to)) return 'Origin and destination cannot be the same.';
    if (!validDate(leg.date)) return 'Choose a valid departure date.';
    if (leg.date < todayAt(leg.from, now)) return 'Choose a departure date that is today or later at the origin airport.';
    return null;
  };
  if (tripType === 'multi-city') {
    if (!Array.isArray(multiLegs) || multiLegs.length < 2 || multiLegs.length > 4) return failure('Add between two and four connected city legs.');
    for (const leg of multiLegs) { const error = validateLeg(leg); if (error) return failure(error); }
    if (multiLegs.some((leg, index) => index > 0 && (code(multiLegs[index - 1].to) !== code(leg.from) || multiLegs[index - 1].date > leg.date))) return failure('Connect each leg from the previous arrival airport and keep dates in order.');
    const legs = multiLegs.map((leg) => ({ from: code(leg.from), to: code(leg.to), date: leg.date }));
    return { data: { origin: legs[0].from, destination: legs.at(-1).to, departure: legs[0].date, legs, tripType, ...travellers, travelClass } };
  }
  const error = validateLeg({ from, to, date: departure });
  if (error) return failure(error);
  if (!['one-way', 'round-trip'].includes(tripType)) return failure('Choose a supported trip type.');
  if (tripType === 'round-trip' && (!validDate(returnDate) || returnDate <= departure)) return failure('Choose a return date after your departure date.');
  return { data: { origin: code(from), destination: code(to), departure, returnDate: tripType === 'round-trip' ? returnDate : null, tripType, ...travellers, travelClass } };
}
