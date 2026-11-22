import test from "node:test";
import assert from "node:assert/strict";
import { buildFareBaseline } from "./fareBaseline.js";

const now = new Date("2026-10-15T08:00:00Z");
const flight = { origin: "DEL", destination: "BLR", departureDate: "2026-10-30", tripType: "one-way", currency: "INR", airline: "IndiGo", travelClass: 1, adults: 1, children: 0, infants: 0 };
const point = (day, price) => ({ price, currency: "INR", observedAt: `2026-10-${String(day).padStart(2, "0")}T06:00:00Z`, source: "serpapi_google_flights" });

test("one observed fare is shown without inventing a forecast", () => {
  const result = buildFareBaseline(flight, [point(15, 5000)], now);
  assert.equal(result.currentFare, 5000);
  assert.equal(result.observationCount, 1);
  assert.equal(result.status, "insufficient_data");
  assert.deepEqual(result.outlook, []);
});

test("real upward, downward and stable movements are derived from observations", () => {
  for (const [prices, direction] of [[[4000, 4200, 4500, 4800], "up"], [[4800, 4600, 4300, 4000], "down"], [[4000, 4000, 4000, 4000], "stable"]]) {
    const result = buildFareBaseline(flight, prices.map((price, index) => point(12 + index, price)), now);
    assert.equal(result.trend.direction, direction);
    assert.equal(result.status, "scenario_available");
    assert.deepEqual(result.outlook.map((item) => item.daysAhead), [1]);
  }
});

test("same-day refreshes are not independent trend days", () => {
  const result = buildFareBaseline(flight, [point(13, 4000), point(14, 4200), { ...point(14, 4300), observedAt: "2026-10-14T16:00:00Z" }, point(15, 4400)], now);
  assert.equal(result.observationCount, 4);
  assert.equal(result.trend.distinctDays, 3);
  assert.equal(result.status, "scenario_available");
  assert.deepEqual(result.outlook.map((item) => item.daysAhead), [1]);
});

test("outliers are bounded and projection ends before departure", () => {
  const result = buildFareBaseline({ ...flight, departureDate: "2026-10-19" }, [point(9, 3900), point(10, 4000), point(11, 4100), point(12, 80000), point(13, 4200), point(14, 4300), point(15, 4400)], now);
  assert.equal(result.outlook.length, 2);
  assert.equal(result.outlook.at(-1).date, "2026-10-18");
  assert.equal(result.outlook[1].daysAhead, 3);
  assert.ok(result.outlook[0].lower.fare <= result.outlook[0].central.fare);
  assert.ok(result.outlook[0].central.fare <= result.outlook[0].upper.fare);
  assert.ok(result.dailyRates.upper <= Math.log(1.08));
  assert.ok(result.dailyRates.lower >= -Math.log(1.08));
});

test("invalid prices, currency, departure and unsupported itinerary are explicit", () => {
  assert.equal(buildFareBaseline(flight, [{ ...point(15, 0) }], now).status, "insufficient_data");
  assert.equal(buildFareBaseline({ ...flight, currency: "" }, [point(15, 5000)], now).currency, null);
  assert.equal(buildFareBaseline({ ...flight, departureDate: "2026-10-15" }, [point(15, 5000)], now).status, "departure_reached");
  assert.equal(buildFareBaseline({ ...flight, departureDate: "2026-10-14" }, [point(14, 5000)], now).status, "departure_reached");
  assert.equal(buildFareBaseline({ ...flight, tripType: "round-trip" }, [point(15, 5000)], now).status, "unsupported_itinerary");
});

test("tomorrow departure has no future booking-day projection", () => {
  const result = buildFareBaseline({ ...flight, departureDate: "2026-10-16" }, [point(12, 4000), point(13, 4200), point(14, 4300), point(15, 4400)], now);
  assert.equal(result.outlook.length, 0);
});


test("early outlook needs three real booking days and reports longer horizon requirements", () => {
  const result = buildFareBaseline(flight, [point(13, 4000), point(14, 4100), point(15, 4200)], now);
  assert.equal(result.bookingDayCount, 3);
  assert.equal(result.historySpanDays, 2);
  assert.deepEqual(result.outlook.map((item) => item.daysAhead), [1]);
  const longer = result.outlookAvailability.find((item) => item.daysAhead === 3);
  assert.equal(longer.missingBookingDays, 4);
  assert.equal(longer.missingHistoryDays, 4);
  assert.match(longer.reason, /3\/7 booking days/);
});

test("multiple quotes on one day never unlock an early outlook", () => {
  const result = buildFareBaseline(flight, [point(15, 4000), point(15, 4100), point(15, 4200)], now);
  assert.equal(result.bookingDayCount, 1);
  assert.deepEqual(result.outlook, []);
});
