import test from "node:test";
import assert from "node:assert/strict";
import { getFareCalendar } from "./fareCalendar.js";

test("nearby verified Indian holiday is included with source and no assumed fare direction", () => {
  const result = getFareCalendar({ origin: "DEL", destination: "BLR", departureDate: "2026-11-10" }, "2026-10-15");
  assert.equal(result.status, "verified_calendar_context");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, "Diwali (Deepavali)");
  assert.equal(result.events[0].date, "2026-11-08");
  assert.equal(result.events[0].expectedFareDirection, "UNDETERMINED");
  assert.match(result.events[0].sourceUrl, /^https:\/\/nhai\.gov\.in\//);
});

test("unrelated dates and unverified route/year have distinct empty states", () => {
  assert.deepEqual(getFareCalendar({ origin: "DEL", destination: "BLR", departureDate: "2026-10-28" }, "2026-10-15"), { status: "no_nearby_listed_holiday", events: [] });
  const us = getFareCalendar({ origin: "JFK", destination: "LAX", departureDate: "2026-11-10" }, "2026-10-15");
  assert.equal(us.status, "verified_calendar_context");
  assert.equal(us.events[0].title, "Veterans Day");
  assert.match(us.events[0].sourceUrl, /^https:\/\/www\.opm\.gov\//);
  const uncovered = getFareCalendar({ origin: "DEL", destination: "BLR", departureDate: "2027-11-10" }, "2026-10-15");
  assert.equal(uncovered.status, "not_covered");
  assert.match(uncovered.reason, /2027/);
});
