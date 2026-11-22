import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { buildStationIndex, fetchWeatherProduct, newestWeatherReport, normalizeObservation, normalizeForecast } from "./weatherService.js";

test("station directory maps worldwide IATA codes to weather-capable ICAO stations", () => {
  const index = buildStationIndex([
    { iataId: "DEL", icaoId: "VIDP", priority: 1, siteType: ["METAR", "TAF"] },
    { iataId: "DEL", icaoId: "VZZZ", priority: 8, siteType: ["METAR"] },
    { iataId: "JFK", icaoId: "KJFK", priority: 0, siteType: ["METAR", "TAF"] },
    { iataId: "XXX", icaoId: "BAD", priority: 0, siteType: ["METAR"] },
    { iataId: "NOW", icaoId: "KNOW", priority: 0, siteType: [] },
  ]);
  assert.equal(index.get("DEL"), "VIDP");
  assert.equal(index.get("JFK"), "KJFK");
  assert.equal(index.has("XXX"), false);
  assert.equal(index.has("NOW"), false);
});

test("METAR normalization exposes decoded operational fields without inventing values", () => {
  assert.deepEqual(normalizeObservation({ rawOb: "METAR KJFK", reportTime: "2026-10-06T12:00:00Z", temp: 22, dewp: 15, wdir: 180, wspd: 12, visib: 10, wxString: "RA", cover: "BKN", fltCat: "MVFR" }), {
    report: "METAR KJFK",
    observedAt: "2026-10-06T12:00:00Z",
    temperatureC: 22,
    dewpointC: 15,
    windDirectionDegrees: 180,
    windSpeedKnots: 12,
    visibilityMiles: 10,
    visibilityIsAtLeast: false,
    conditions: "RA",
    cloudCover: "BKN",
    flightCategory: "MVFR",
  });
  assert.equal(normalizeObservation(null), null);
  assert.deepEqual(
    { visibilityMiles: normalizeObservation({ visib: "10+" }).visibilityMiles, visibilityIsAtLeast: normalizeObservation({ visib: "10+" }).visibilityIsAtLeast },
    { visibilityMiles: 10, visibilityIsAtLeast: true },
  );
});

test("current METAR refreshes are coalesced and reused within the one-minute cache", async (context) => {
  let calls = 0;
  context.mock.method(axios, "get", async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { data: [{ rawOb: "METAR KQZX", reportTime: "2026-10-07T06:00:00Z" }] };
  });
  const [first, second] = await Promise.all([
    fetchWeatherProduct("KQZX", "metar"),
    fetchWeatherProduct("KQZX", "metar"),
  ]);
  const third = await fetchWeatherProduct("KQZX", "metar");
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(first.stale, false);
  assert.ok(first.fetchedAt);
});

test("latest METAR is selected from report timestamps even when response order changes", () => {
  const reports = [
    { reportTime: "2026-10-07T06:00:00Z", rawOb: "older" },
    { reportTime: "2026-10-07T07:00:00Z", rawOb: "newer" },
  ];
  assert.equal(newestWeatherReport(reports, "metar").rawOb, "newer");
  assert.equal(newestWeatherReport([], "metar"), null);
});

test('TAF validity converts provider Unix seconds into ISO times without inventing missing dates', () => {
  assert.deepEqual(normalizeForecast({ rawTAF: 'TAF KLAX', issueTime: '2026-10-28T17:20:00.000Z', validTimeFrom: 1793210400, validTimeTo: 1793318400 }), {
    report: 'TAF KLAX', issuedAt: '2026-10-28T17:20:00.000Z', validFrom: '2026-10-28T18:00:00.000Z', validTo: '2026-10-30T00:00:00.000Z',
  });
  assert.equal(normalizeForecast({}).validFrom, null);
  assert.equal(normalizeForecast(null), null);
});

test('latest TAF selection compares numeric Unix issue times with ISO timestamps', () => {
  const reports = [
    { issueTime: 1793210400, rawTAF: 'older numeric' },
    { issueTime: 1793214000, rawTAF: 'newer numeric' },
    { issueTime: '2026-10-28T17:20:00Z', rawTAF: 'older ISO' },
  ];
  assert.equal(newestWeatherReport(reports, 'taf').rawTAF, 'newer numeric');
  assert.equal(newestWeatherReport([...reports].reverse(), 'taf').rawTAF, 'newer numeric');
  assert.equal(normalizeForecast({ issueTime: 1e100 }).issuedAt, null);
});
