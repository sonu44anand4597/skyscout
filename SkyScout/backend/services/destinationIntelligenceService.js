import DestinationIntelligence from "../models/DestinationIntelligence.js";
import { claimProviderLease, releaseProviderLease } from "./providerState.js";
import { fetchDestinationReports } from "./destinationSources.js";
import { normalizeReports, overallDisruption } from "./destinationAnalysis.js";
import { logServiceError } from './safeLogging.js';

const REFRESH_MS = 30 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;
const inFlight = new Map();

function responseFor(record, destination, stale = false, now = new Date()) {
  const events = (record.events || []).filter((event) => new Date(event.expiresAt) > now);
  return {
    available: true,
    destination: {
      airportCode: destination.airportCode,
      airportName: destination.airportName,
      city: destination.city,
      country: destination.country,
      countryCode: destination.countryCode,
    },
    overallDisruption: overallDisruption(events),
    eventCount: events.length,
    checkedAt: record.checkedAt,
    stale,
    searchesCompleted: record.searchesCompleted,
    searchesAttempted: record.searchesAttempted,
    coverage: record.coverage,
    events,
    sourceScope: "Recent SerpApi Google News results, including searches for official-domain reports; no direct authority feed",
  };
}

async function refresh(destination, dependencies) {
  const { findCached, save, fetch, claimLease, releaseLease, now } = dependencies;
  let owner;
  try {
    owner = await claimLease(`destination:${destination.key}`, 50_000);
    if (owner === null) {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const cached = await findCached(destination.key);
        if (cached && new Date(cached.refreshAfter) > now()) return responseFor(cached, destination, false, now());
      }
      throw new Error("Another destination refresh is still in progress.");
    }
    const fetched = await fetch(destination);
    const raw = Array.isArray(fetched) ? fetched : fetched.reports;
    const checkedAt = now();
    const diagnostics = {};
    const events = normalizeReports(raw, destination, checkedAt, diagnostics);
    console.info("Destination analysis", JSON.stringify({ key: destination.key, ...diagnostics }));
    const record = await save(destination, {
      key: destination.key, city: destination.city, country: destination.country,
      countryCode: destination.countryCode, events, checkedAt,
      searchesCompleted: Array.isArray(fetched) ? undefined : fetched.searchesCompleted,
      searchesAttempted: Array.isArray(fetched) ? undefined : fetched.searchesAttempted,
      coverage: Array.isArray(fetched) ? undefined : fetched.coverage,
      diagnostics,
      refreshAfter: new Date(checkedAt.getTime() + REFRESH_MS),
      expiresAt: new Date(checkedAt.getTime() + STALE_MS),
    });
    return responseFor(record, destination, false, now());
  } finally {
    await releaseLease(`destination:${destination.key}`, owner).catch((error) => logServiceError('destination_lease_release_failed', error));
  }
}

export async function getDestinationIntelligence(destination, overrides = {}) {
  const dependencies = {
    findCached: (key) => DestinationIntelligence.findOne({ key, expiresAt: { $gt: new Date() } }).lean(),
    save: async (place, payload) => {
      await DestinationIntelligence.updateOne({ key: place.key }, { $set: payload }, { upsert: true });
      return payload;
    },
    fetch: fetchDestinationReports,
    claimLease: claimProviderLease,
    releaseLease: releaseProviderLease,
    now: () => new Date(),
    ...overrides,
  };
  const cached = await dependencies.findCached(destination.key);
  if (cached && new Date(cached.refreshAfter) > dependencies.now()) return responseFor(cached, destination, false, dependencies.now());
  if (inFlight.has(destination.key)) return inFlight.get(destination.key);
  const request = refresh(destination, dependencies).catch((error) => {
    logServiceError('destination_refresh_failed', error);
    if (cached && new Date(cached.expiresAt) > dependencies.now()) return responseFor(cached, destination, true, dependencies.now());
    return {
      available: false, destination: {
        airportCode: destination.airportCode, airportName: destination.airportName,
        city: destination.city, country: destination.country, countryCode: destination.countryCode,
      },
      message: "Destination intelligence is temporarily unavailable.",
      events: [],
    };
  }).finally(() => inFlight.delete(destination.key));
  inFlight.set(destination.key, request);
  return request;
}
