import { resolveDestination } from "./destinationResolver.js";

// Published 2026 national holiday dates from the National Highways Authority
// of India's 2026 calendar. These are calendar context, not fare evidence.
const INDIA_2026_SOURCE = "https://nhai.gov.in/assets/pdf/List_of_holidays-2026.pdf";
const INDIA_2026 = Object.freeze([
  ["2026-01-26", "Republic Day"],
  ["2026-03-04", "Holi"],
  ["2026-03-21", "Id-ul-Fitr"],
  ["2026-03-26", "Ram Navami"],
  ["2026-03-31", "Mahavir Jayanti"],
  ["2026-04-03", "Good Friday"],
  ["2026-05-01", "Buddha Purnima"],
  ["2026-05-27", "Id-ul-Zuha"],
  ["2026-06-26", "Muharram"],
  ["2026-08-15", "Independence Day"],
  ["2026-08-26", "Milad-un-Nabi"],
  ["2026-09-04", "Janmashtami"],
  ["2026-10-02", "Gandhi Jayanti"],
  ["2026-10-20", "Dussehra"],
  ["2026-11-08", "Diwali (Deepavali)"],
  ["2026-11-24", "Guru Nanak's Birthday"],
  ["2026-12-25", "Christmas Day"],
]);
const US_SOURCE = "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/";
const US_HOLIDAYS = Object.freeze([
  ["2026-01-01", "New Year's Day"], ["2026-01-19", "Martin Luther King Jr. Day"], ["2026-02-16", "Washington's Birthday"], ["2026-05-25", "Memorial Day"], ["2026-06-19", "Juneteenth"], ["2026-07-03", "Independence Day (observed)"], ["2026-09-07", "Labor Day"], ["2026-10-12", "Columbus Day"], ["2026-11-11", "Veterans Day"], ["2026-11-26", "Thanksgiving Day"], ["2026-12-25", "Christmas Day"],
  ["2027-01-01", "New Year's Day"], ["2027-01-18", "Martin Luther King Jr. Day"], ["2027-02-15", "Washington's Birthday"], ["2027-05-31", "Memorial Day"], ["2027-06-18", "Juneteenth (observed)"], ["2027-07-05", "Independence Day (observed)"], ["2027-09-06", "Labor Day"], ["2027-10-11", "Columbus Day"], ["2027-11-11", "Veterans Day"], ["2027-11-25", "Thanksgiving Day"], ["2027-12-24", "Christmas Day (observed)"],
]);

function differenceDays(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function getFareCalendar(flight, today) {
  const origin = resolveDestination(flight.origin);
  const destination = resolveDestination(flight.destination);
  const inIndia = origin?.countryCode === "IN" && destination?.countryCode === "IN";
  const inUS = origin?.countryCode === "US" && destination?.countryCode === "US";
  const covered = inIndia && flight.departureDate?.startsWith("2026-") ? INDIA_2026 : inUS && /^202[67]-/.test(flight.departureDate || "") ? US_HOLIDAYS : null;
  if (!covered) return { status: "not_covered", events: [], reason: `No verified national holiday calendar is installed for ${origin?.countryCode || "unknown"} to ${destination?.countryCode || "unknown"} in ${flight.departureDate?.slice(0, 4) || "the selected year"}. Regional, school and city events require separate source verification.` };
  const events = covered.filter(([date]) => differenceDays(date, today) >= 0 && Math.abs(differenceDays(date, flight.departureDate)) <= 7)
    .map(([date, title]) => ({ title, category: "national_holiday", date, sourceName: inIndia ? "National Highways Authority of India 2026 calendar" : "U.S. Office of Personnel Management", sourceUrl: inIndia ? INDIA_2026_SOURCE : US_SOURCE, location: inIndia ? "India" : "United States", geographicScope: 'national', timing: date > flight.departureDate ? 'after_departure' : date === flight.departureDate ? 'departure_day' : 'before_departure', routeRelevance: date > flight.departureDate ? 'This holiday follows departure; an effect on the outbound flight is unverified.' : "Verified national holiday within seven days of this domestic departure", expectedFareDirection: "UNDETERMINED", verificationStatus: "official_calendar", explanation: "The holiday date is verified; a route-specific fare or demand effect has not been established." }));
  return { status: events.length ? "verified_calendar_context" : "no_nearby_listed_holiday", events };
}
