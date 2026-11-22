import assert from "node:assert/strict";
import test from "node:test";
import TrackedFlight from "../models/TrackedFlight.js";
import { flightDestinationIntelligence } from "../controllers/trackedFlightController.js";
import { resolveDestination } from "./destinationResolver.js";
import { classifyReport, normalizeReports, overallDisruption } from "./destinationAnalysis.js";
import { getDestinationIntelligence } from "./destinationIntelligenceService.js";
import { destinationQueries, fetchDestinationReports } from "./destinationSources.js";

const destination = resolveDestination("CDG");
const now = new Date("2026-10-07T12:00:00Z");

function report(title, host, isoDate = "2026-10-06T12:00:00Z") {
  return { title, link: `https://${host}/article`, iso_date: isoDate, source: { name: host } };
}

test("resolves airports by catalog code without guessing unknown destinations", () => {
  assert.deepEqual([destination.city, destination.countryCode, destination.airportCode], ["Paris", "FR", "CDG"]);
  assert.equal(resolveDestination("???"), null);
  assert.deepEqual([resolveDestination("PXN").city, resolveDestination("PXN").countryCode], ["Purnea", "IN"]);
});

test("searches city, airport code, transport, weather and official domains", () => {
  const queries = destinationQueries(resolveDestination("MIA"));
  assert.ok(queries.some((item) => item.q.includes("Miami International Airport")));
  assert.ok(queries.some((item) => item.q.includes("MIA airport")));
  assert.ok(queries.some((item) => item.group === "transport"));
  assert.ok(queries.some((item) => item.group === "official" && item.q.includes("site:gov")));
});

test("provider counts empty searches as checked and keeps partial results", async () => {
  const previous = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = "test-only";
  try {
    const fetched = await fetchDestinationReports(resolveDestination("MIA"), async (_url, options) => {
      if (options.params.q.includes("transport")) throw new Error("temporary provider failure");
      if (options.params.q.includes("weather")) return { data: { error: "Google News hasn't returned any results for this query." } };
      return { data: { search_metadata: { status: "Success" }, news_results: [{ title: "Report" }] } };
    });
    assert.equal(fetched.coverage.attempted, 7);
    assert.equal(fetched.coverage.failed, 1);
    assert.equal(fetched.coverage.successful, 6);
    assert.equal(fetched.reports.length, 4);
  } finally { if (previous === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = previous; }
});

test("classifies traveller disruption but ignores ordinary destination headlines", () => {
  assert.equal(classifyReport("Paris metro strike disrupts service", "news"), "TRANSPORT_STRIKE");
  assert.equal(classifyReport("Student protests disrupt Paris traffic", "news"), "PROTEST_OR_CIVIL_DISRUPTION");
  assert.equal(classifyReport("Authors protest AI at London book fair", "news"), null);
  assert.equal(classifyReport("Miami flood zone maps for homeowners", "news"), null);
  assert.equal(classifyReport("Paris fashion show opens", "news"), null);
});

test("requires recent recognized sources, destination relevance and corroboration", () => {
  const events = normalizeReports([
    report("Student protests in Paris disrupt schools", "reuters.com"),
    report("Paris student protest disrupts local schools", "cbsnews.com"),
    report("Student protests in Paris disrupt schools", "random-blog.example"),
    report("Student protests in Paris disrupt schools", "apnews.com", "2026-09-15T12:00:00Z"),
    report("Student protests in Lyon disrupt schools", "apnews.com"),
  ], destination, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].sources.length, 2);
  assert.equal(events[0].severity, "low");
  assert.equal(events[0].confidence, "medium");
  assert.deepEqual(events[0].affectedAreas, []);
  assert.equal(events[0].status, "recent_report");
  assert.equal(overallDisruption(events), "low");
});

test("one official source may be shown but one news source cannot", () => {
  const title = "Paris transport strike warning from authority";
  assert.equal(normalizeReports([report(title, "reuters.com")], destination, now).length, 0);
  const events = normalizeReports([report(title, "service.gov.uk")], destination, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].sources[0].tier, "official");
});

test("the chosen headline retains its own original publisher URL", () => {
  const events = normalizeReports([
    { ...report("Paris student protests disrupt traffic", "reuters.com", "2026-10-06T13:00:00Z"), link: "https://reuters.com/newer-story" },
    { ...report("Paris student protest movement disrupts traffic", "reuters.com", "2026-10-06T12:00:00Z"), link: "https://reuters.com/older-story" },
    report("Students protest in Paris as traffic slows", "cbsnews.com"),
  ], destination, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].headline, "Paris student protests disrupt traffic");
  assert.equal(events[0].sources[0].url, "https://reuters.com/newer-story");
});

test("extracts named affected locations, transport and source counts without inventing an event end", () => {
  const delhi = resolveDestination("DEL");
  const diagnostics = {};
  const events = normalizeReports([
    report("Delhi Jantar Mantar protest: 11 Metro stations closed, traffic curbs announced", "thehindu.com"),
    report("Delhi Jantar Mantar protest closes 11 Metro stations amid traffic curbs", "indiatoday.in"),
    report("Delhi traffic update", "reuters.com", "2026-09-01T12:00:00Z"),
  ], delhi, now, diagnostics);
  assert.equal(events.length, 1);
  assert.ok(events[0].affectedAreas.includes("Jantar Mantar"));
  assert.ok(events[0].affectedTransport.includes("metro"));
  assert.equal(events[0].sourceCount, 2);
  assert.equal(events[0].eventEnd, undefined);
  assert.equal(diagnostics.rejectedStale, 1);
  assert.equal(diagnostics.eventsProduced, 1);
});

test("cache reuses fresh destination response and marks older fallback stale", async () => {
  let record = null;
  let fetches = 0;
  let fail = false;
  const dependencies = {
    now: () => now,
    findCached: async () => record,
    save: async (_place, payload) => { record = payload; return payload; },
    fetch: async () => { fetches += 1; if (fail) throw new Error("provider failed"); return []; },
    claimLease: async () => "owner",
    releaseLease: async () => {},
  };
  const first = await getDestinationIntelligence(destination, dependencies);
  const second = await getDestinationIntelligence(destination, dependencies);
  assert.equal(first.available, true);
  assert.equal(second.eventCount, 0);
  assert.equal(fetches, 1);
  record.refreshAfter = new Date(now.getTime() - 1);
  fail = true;
  const fallback = await getDestinationIntelligence(destination, dependencies);
  assert.equal(fallback.stale, true);
  assert.equal(fetches, 2);
});

test("tracked-flight lookup is scoped to the authenticated owner", async (context) => {
  const id = "507f1f77bcf86cd799439011";
  const owner = "507f1f77bcf86cd799439012";
  let query;
  context.mock.method(TrackedFlight, "findOne", (filter) => {
    query = filter;
    return { select: () => ({ lean: async () => null }) };
  });
  const req = { params: { id }, userId: owner };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await flightDestinationIntelligence(req, res, () => {});
  assert.deepEqual(query, { _id: id, userId: owner });
  assert.equal(res.code, 404);
});
