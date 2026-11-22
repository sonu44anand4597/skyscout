import { resolveDestination } from "./destinationResolver.js";
import { quoteIsFresh } from './quoteFreshness.js';

export const FARE_ENGINE_VERSION = "fare-scenarios-v2";
const DAY_MS = 86_400_000;
export const FARE_HORIZONS = [1, 3, 7, 14];
const requiredDays = (day) => day === 1 ? 3 : Math.max(7, day + 3);
const MAX_DAILY_LOG_RATE = Math.log(1.08);

function localDate(now, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function dayNumber(date) {
  const milliseconds = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / DAY_MS) : NaN;
}

function quantile(sorted, position) {
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

function farePoint(currentFare, rate, days) {
  const fare = Math.max(1, Math.round(currentFare * Math.exp(rate * days)));
  return { fare, change: fare - currentFare, changePercent: Number(((fare / currentFare - 1) * 100).toFixed(1)) };
}

export function buildFareBaseline(flight, observations, now = new Date()) {
  const origin = resolveDestination(flight.origin);
  const destination = resolveDestination(flight.destination);
  const timezone = origin?.timezone || (origin?.countryCode === 'IN' ? 'Asia/Kolkata' : 'UTC');
  const today = localDate(now, timezone);
  const departureDate = flight.departureDate;
  const daysUntilDeparture = dayNumber(departureDate) - dayNumber(today);
  const currency = String(flight.currency || "").toUpperCase();
  const validCurrency = /^[A-Z]{3}$/.test(currency);
  const validPrices = (observations || []).filter((item) => Number.isFinite(item.price) && item.price > 0 && item.currency === currency && Number.isFinite(new Date(item.observedAt).getTime()) && new Date(item.observedAt) <= now)
    .sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
  const latest = validPrices.at(-1);
  const currentFare = latest?.price;
  const supported = flight.tripType === "one-way";
  const base = {
    version: FARE_ENGINE_VERSION, generatedAt: now.toISOString(), timezone, today, departureDate,
    route: { origin: flight.origin, destination: flight.destination, originCity: origin?.city || flight.origin, destinationCity: destination?.city || flight.destination },
    airline: flight.airline || null, flightNumber: flight.flightNumber || null,
    itinerary: { tripType: flight.tripType, travelClass: flight.travelClass, adults: flight.adults, children: flight.children, infants: flight.infants },
    currency: validCurrency ? currency : null, currentFare: currentFare ?? null,
    currentObservation: latest ? { observedAt: new Date(latest.observedAt).toISOString(), source: latest.source || "serpapi_google_flights", stale: !quoteIsFresh(latest.observedAt, now) } : null,
    observationCount: validPrices.length, daysUntilDeparture: Number.isFinite(daysUntilDeparture) ? daysUntilDeparture : null,
    bookingDayCount: 0, historySpanDays: 0, outlookAvailability: [], trend: null, evidence: "insufficient", dailyRates: null, outlook: [], guidance: "Insufficient evidence", guidanceReason: "More comparable fare observations are needed.",
    status: "insufficient_data", limitations: ["Scenarios are projections from this exact tracked itinerary, not a trained fare forecast or confidence interval."],
  };
  if (!supported) { base.status = "unsupported_itinerary"; base.guidanceReason = "Day-wise scenarios currently support one-way itineraries only; return and multi-city booking totals cannot be safely decomposed."; return base; }
  if (!validCurrency || !currentFare) { base.guidanceReason = "A valid observed fare and currency are required."; return base; }
  if (!Number.isFinite(daysUntilDeparture) || daysUntilDeparture <= 0) { base.status = "departure_reached"; base.guidanceReason = "The flight departs today or has already departed; no future booking dates remain."; return base; }

  // The last observed price on each booking date avoids treating rapid refreshes as independent daily evidence.
  const byDay = new Map();
  for (const item of validPrices) byDay.set(localDate(new Date(item.observedAt), timezone), item);
  const daily = [...byDay].sort(([a], [b]) => a.localeCompare(b));
  base.bookingDayCount = daily.length;
  base.historySpanDays = dayNumber(daily.at(-1)[0]) - dayNumber(daily[0][0]);
  base.outlookAvailability = FARE_HORIZONS.map((daysAhead) => {
    const missingBookingDays = Math.max(0, requiredDays(daysAhead) - daily.length);
    const missingHistoryDays = Math.max(0, daysAhead * 2 - base.historySpanDays);
    const beforeDeparture = daysAhead < daysUntilDeparture;
    const reason = !beforeDeparture ? "This horizon reaches or passes departure." : missingBookingDays || missingHistoryDays
      ? `Collecting history: ${daily.length}/${requiredDays(daysAhead)} booking days and ${base.historySpanDays}/${daysAhead * 2} days of history. Monitoring saves quotes automatically; research refreshes do not add booking days.`
      : "Enough observations for a conditional scenario.";
    return { daysAhead, missingBookingDays, missingHistoryDays, beforeDeparture, reason };
  });
  if (daily.length >= 2) {
    const first = daily[0][1];
    const delta = currentFare - first.price;
    base.trend = { observedChange: delta, observedChangePercent: Number(((delta / first.price) * 100).toFixed(1)), from: daily[0][0], to: daily.at(-1)[0], direction: delta > 0 ? "up" : delta < 0 ? "down" : "stable", distinctDays: daily.length };
  }
  if (daily.length < 3) {
    base.guidanceReason = daily.length === 1 ? "One booking-day observation cannot establish a fare trend." : "At least three distinct booking days across two days are needed for a 1-day conditional scenario.";
    return base;
  }
  const rates = [];
  for (let index = 1; index < daily.length; index += 1) {
    const elapsed = dayNumber(daily[index][0]) - dayNumber(daily[index - 1][0]);
    if (elapsed > 0) rates.push(Math.log(daily[index][1].price / daily[index - 1][1].price) / elapsed);
  }
  rates.sort((a, b) => a - b);
  const center = quantile(rates, 0.5);
  const deviations = rates.map((rate) => Math.abs(rate - center)).sort((a, b) => a - b);
  const mad = quantile(deviations, 0.5);
  const filtered = rates.length >= 5 && mad > 0 ? rates.filter((rate) => Math.abs(rate - center) <= 3 * 1.4826 * mad) : rates;
  const cleanRates = (filtered.length >= 3 ? filtered : rates).map((rate) => Math.max(-MAX_DAILY_LOG_RATE, Math.min(MAX_DAILY_LOG_RATE, rate))).sort((a, b) => a - b);
  const lower = Math.min(0, quantile(cleanRates, 0.2));
  const middle = quantile(cleanRates, 0.5);
  const upper = Math.max(0, quantile(cleanRates, 0.8));
  const historySpanDays = dayNumber(daily.at(-1)[0]) - dayNumber(daily[0][0]);
  base.historySpanDays = historySpanDays;
  base.dailyRates = { lower, central: middle, upper, unit: "daily log change", bound: "Each observed daily log change is capped at the equivalent of 8% per day; lower and upper use the 20th and 80th percentiles of observed changes, including the unchanged fare as a boundary." };
  base.outlook = FARE_HORIZONS.filter((day) => day < daysUntilDeparture && daily.length >= requiredDays(day) && historySpanDays >= day * 2).map((day) => {
    const date = new Date((dayNumber(today) + day) * DAY_MS).toISOString().slice(0, 10);
    return { date, daysAhead: day, lower: farePoint(currentFare, lower, day), central: farePoint(currentFare, middle, day), upper: farePoint(currentFare, upper, day), evidence: "conditional observed-trend scenario", method: "20th, 50th and 80th percentiles of bounded daily log fare changes", observationCount: validPrices.length, distinctBookingDays: daily.length, historySpanDays };
  });
  base.evidence = base.outlook.length ? "limited_observed_trend" : "insufficient";
  base.status = base.outlook.length ? "scenario_available" : "insufficient_data";
  base.guidance = "Monitor this fare";
  base.guidanceReason = base.outlook.length ? "Conditional scenarios use only the tracked fare series; no validated forecast or event-to-price model supports a buy-or-wait recommendation." : "The observation span is too short for a defensible 1, 3, 7 or 14-day scenario.";
  return base;
}
