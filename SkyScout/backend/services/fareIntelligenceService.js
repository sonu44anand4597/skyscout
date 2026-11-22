import { buildDailyFare, backtestFare } from "./fareDaily.js";
import { reportIdentity, readReport, writeReport, recordReportAttempt, canStoreGrounding } from "./intelligenceReports.js";
import PriceObservation from "../models/PriceObservation.js";
import FareIntelligenceAnalysis from "../models/FareIntelligenceAnalysis.js";
import RateLimitBucket from "../models/RateLimitBucket.js";
import { buildFareBaseline, FARE_ENGINE_VERSION } from "./fareBaseline.js";
import { discoverFareEvents } from "./fareEvents.js";
import { getFareCalendar } from "./fareCalendar.js";
import { claimProviderLease, releaseProviderLease } from './providerState.js';

const researchInFlight = new Map();
const failureCache = new Map();
const SIX_HOURS = 6 * 60 * 60 * 1000;
function cooldownDuration() {
  const seconds = Number(process.env.FARE_INTELLIGENCE_COOLDOWN_SECONDS || process.env.FARE_INTELLIGENCE_CACHE_TTL);
  return Number.isFinite(seconds) && seconds >= 300 && seconds <= 86_400 ? seconds * 1000 : SIX_HOURS;
}

function makeAudit(previous, observations, timezone) {
  const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const audits = [];
  for (const analysis of previous) {
    const prior = analysis.baseline;
    for (const projected of prior?.outlook || []) {
      const later = observations.find((observation) => new Date(observation.observedAt) > new Date(analysis.createdAt) && dayFormat.format(new Date(observation.observedAt)) === projected.date && observation.currency === analysis.currency);
      if (!later) continue;
      audits.push({ generatedAt: analysis.createdAt, evaluatedDate: projected.date, projectedLower: projected.lower.fare, projectedCentral: projected.central.fare, projectedUpper: projected.upper.fare, actualFare: later.price, differenceFromCentral: later.price - projected.central.fare, withinScenarioRange: later.price >= projected.lower.fare && later.price <= projected.upper.fare });
      if (audits.length >= 5) return audits;
    }
  }
  return audits;
}

export async function getFareIntelligence(flight, { research = false, mode = "observed", market = "normal", now = new Date(), loadReport = readReport, saveReport = writeReport, findObservations = async (query) => (await PriceObservation.find(query).sort({ observedAt: -1 }).limit(500).lean()).reverse(), findAnalyses = (query) => FareIntelligenceAnalysis.find(query).sort({ createdAt: -1 }).limit(20).lean(), saveAnalysis = (data) => FareIntelligenceAnalysis.create(data), updateAnalysis = (id, data) => FareIntelligenceAnalysis.findByIdAndUpdate(id, { $set: data }, { returnDocument: "after" }).lean(), discover = discoverFareEvents, cooldown = async ({ claim = false } = {}) => {
  const id = `fare-intelligence-cooldown:${flight._id}`;
  if (!claim) return !await RateLimitBucket.exists({ _id: id, expiresAt: { $gt: now } });
  await RateLimitBucket.deleteOne({ _id: id, expiresAt: { $lte: now } });
  try { await RateLimitBucket.create({ _id: id, count: 1, expiresAt: new Date(Date.now() + cooldownDuration()) }); return true; }
  catch (error) { if (error.code === 11000) return false; throw error; }
}, quota = async (limit) => {
  const date = new Date().toISOString().slice(0, 10);
  const bucket = await RateLimitBucket.findOneAndUpdate({ _id: `gemini-grounded:${date}` }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 2 * 86_400_000) } }, { upsert: true, returnDocument: "after" }).lean();
  return bucket.count <= limit;
} } = {}) {
  const query = { userId: flight.userId, trackedFlightId: flight._id };
  const [observations, previous] = await Promise.all([findObservations(query), findAnalyses(query)]);
  const baseline = buildFareBaseline(flight, observations, now);
  const identity = reportIdentity(flight);
  let storageUnavailable = false;
  const safelyLoadReport = async () => {
    try { return await loadReport(identity.key); }
    catch { storageUnavailable = true; return null; }
  };
  const stored = await safelyLoadReport();
  const freshReport = stored?.report && new Date(stored.expiresAt) > now;
  const latest = previous[0];
  const sameSnapshot = latest && latest.engineVersion === FARE_ENGINE_VERSION && latest.observedFare === baseline.currentFare && latest.bookingDate === baseline.today && latest.observedAt && new Date(latest.observedAt).toISOString() === baseline.currentObservation?.observedAt;
  let analysis = sameSnapshot ? latest : null;
  if (!analysis && baseline.currentObservation && baseline.currency) analysis = await saveAnalysis({ ...query, engineVersion: FARE_ENGINE_VERSION, currency: baseline.currency, observedFare: baseline.currentFare, observedAt: new Date(baseline.currentObservation.observedAt), bookingDate: baseline.today, baseline });
  const key = `${flight.userId}:${flight._id}:${baseline.today}`;
  for (const [cachedKey, failure] of failureCache) if (failure.expiresAt <= now.getTime()) failureCache.delete(cachedKey);
  if (failureCache.size >= 500) failureCache.delete(failureCache.keys().next().value);
  const recentFailure = failureCache.get(key);
  let eventState = { status: analysis?.researchLastStatus === "grounded_result" ? "previously_researched" : analysis?.researchLastStatus || "not_checked", model: null, checkedAt: analysis?.researchCheckedAt || null };
  if (stored?.report) eventState = { ...stored.report, stale: !freshReport, cache: "persistent", storageAuthorized: true };
  if (research && !freshReport && baseline.daysUntilDeparture > 0) {
    if (recentFailure && recentFailure.expiresAt > now.getTime()) {
      eventState = recentFailure.result;
    } else if (process.env.FARE_INTELLIGENCE_ENABLED === "false") {
      eventState = { status: "disabled", model: null, checkedAt: now };
    } else if (!process.env.GEMINI_API_KEY) {
      eventState = { status: "not_configured", model: null, checkedAt: now };
    } else {
      let work = researchInFlight.get(key);
      if (!work) {
        work = (async () => {
          const leaseKey = `research:${identity.key}`;
          const leaseOwner = await claimProviderLease(leaseKey, 90000);
          if (leaseOwner === null) return { status: 'research_in_progress', checkedAt: now.toISOString() };
          try {
          // A different process may have persisted a report while this request acquired its lease.
          const completed = await safelyLoadReport();
          if (completed?.report && new Date(completed.expiresAt) > now) return { ...completed.report, cache: 'persistent' };
          const configuredLimit = Number(process.env.FARE_INTELLIGENCE_MAX_GROUNDED_REQUESTS);
          const limit = Math.min(Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 18, 18);
          if (!await cooldown()) return { status: "cooldown", model: process.env.GEMINI_MODEL || "gemini-2.5-flash", checkedAt: now.toISOString() };
          if (!await quota(limit)) return { status: "quota_exceeded", model: process.env.GEMINI_MODEL || "gemini-2.5-flash", checkedAt: now.toISOString() };
          const researchStarted = Date.now();
          let result = await discover(flight, baseline.today);
          // SDK retries are disabled: every retry consumes the shared budget.
          if (result.retryable && Date.now() - researchStarted < 35000 && await quota(limit)) {
            await new Promise((resolve) => setTimeout(resolve, 350 + Math.floor(Math.random() * 250)));
            result = await discover(flight, baseline.today, { timeoutMs: 55000 - (Date.now() - researchStarted) });
          }
          if (!["grounded_result", "no_qualifying_event"].includes(result.status)) failureCache.set(key, { result: { status: result.status, model: result.model || null, checkedAt: result.checkedAt || now.toISOString() }, expiresAt: now.getTime() + 5 * 60_000 });
          if (["grounded_result", "no_qualifying_event"].includes(result.status)) {
            // Keep the provider lease through persistence so another process sees the completed report.
            try { await saveReport(identity, flight, result, now); }
            catch { storageUnavailable = true; }
            await cooldown({ claim: true });
          }
          return result;
          } finally { await releaseProviderLease(leaseKey, leaseOwner); }
        })();
        researchInFlight.set(key, work);
        work.then(() => researchInFlight.delete(key), () => researchInFlight.delete(key));
      }
      eventState = await work;
      if (analysis) analysis = await updateAnalysis(analysis._id, { researchLastStatus: eventState.status, researchCheckedAt: eventState.checkedAt });
    }
  }
  if (research && baseline.daysUntilDeparture !== null && baseline.daysUntilDeparture <= 0 && !stored?.report) eventState = { status: 'departure_reached', checkedAt: null, events: [], message: 'No future booking days remain for this departure.' };
  if (research && stored?.report && !["grounded_result", "no_qualifying_event"].includes(eventState.status)) {
    await recordReportAttempt(identity.key, eventState).catch(() => { storageUnavailable = true; });
    eventState = { ...stored.report, stale: true, cache: "persistent", lastAttempt: { status: eventState.status, checkedAt: eventState.checkedAt, diagnostics: eventState.diagnostics } };
  }
  eventState.storageAuthorized = canStoreGrounding();
  if (storageUnavailable) eventState.storageStatus = 'unavailable';
  return { baseline, daily: buildDailyFare(baseline, { mode, market, events: [...(eventState.events || []), ...(getFareCalendar(flight, baseline.today).events || []).map((event) => ({ ...event, id: `calendar-${event.date}-${event.title}`, eventStart: event.date }))] }), evaluation: backtestFare(flight, observations), monitoring: { status: flight.status, lastCheckError: flight.lastCheckError, lastCheckedAt: flight.lastCheckedAt, nextCheckAt: flight.nextCheckAt }, priceHistory: observations.filter((item) => item.currency === baseline.currency && Number.isFinite(item.price) && item.price > 0 && Number.isFinite(new Date(item.observedAt).getTime())).map((item) => ({ price: item.price, currency: item.currency, observedAt: new Date(item.observedAt).toISOString(), source: item.source || "serpapi_google_flights" })), calendarContext: getFareCalendar(flight, baseline.today), eventIntelligence: eventState, forecastAudit: makeAudit(previous, observations, baseline.timezone), currentAnalysisId: analysis?._id || null };
}
