import axios from "axios";
import { gunzipSync } from "node:zlib";
import { claimProviderLease, readProviderState, releaseProviderLease, storeProviderState, waitForProviderState } from "./providerState.js";
import { logServiceError } from './safeLogging.js';

const FALLBACK_ICAO_BY_IATA = { DEL: "VIDP", BOM: "VABB", BLR: "VOBL", HYD: "VOHS", MAA: "VOMM" };
const METAR_CACHE_MS = 60 * 1000;
const TAF_CACHE_MS = 10 * 60 * 1000;
const DIRECTORY_CACHE_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = "SkyScout/1.0 (aviation weather dashboard)";
const weatherCache = new Map();
const weatherRequests = new Map();
let stationDirectory = { index: new Map(Object.entries(FALLBACK_ICAO_BY_IATA)), expiresAt: 0 };
let directoryRequest;

function weatherTimestamp(value) {
  const time = typeof value === 'number' && value > 0 ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : NaN;
}

export function buildStationIndex(records) {
  const selected = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const iata = String(record?.iataId || "").toUpperCase();
    const icao = String(record?.icaoId || "").toUpperCase();
    const products = Array.isArray(record?.siteType) ? record.siteType : [];
    if (!/^[A-Z]{3}$/.test(iata) || !/^[A-Z0-9]{4}$/.test(icao) || !products.some((item) => item === "METAR" || item === "TAF")) continue;
    const priority = Number.isFinite(record.priority) ? record.priority : 99;
    if (!selected.has(iata) || priority < selected.get(iata).priority) selected.set(iata, { icao, priority });
  }
  return new Map([...selected].map(([iata, value]) => [iata, value.icao]));
}

async function loadStationDirectory() {
  if (stationDirectory.expiresAt > Date.now()) return stationDirectory.index;
  if (directoryRequest) return directoryRequest;
  directoryRequest = axios.get("https://aviationweather.gov/data/cache/stations.cache.json.gz", {
    responseType: "arraybuffer",
    timeout: 15000,
    headers: { "User-Agent": USER_AGENT },
  }).then((response) => {
    const records = JSON.parse(gunzipSync(response.data).toString("utf8"));
    const index = buildStationIndex(records);
    if (index.size < 1000) throw new Error("Station directory did not contain enough usable airport mappings.");
    stationDirectory = { index, expiresAt: Date.now() + DIRECTORY_CACHE_MS };
    return index;
  }).catch((error) => {
    logServiceError('weather_station_directory_failed', error);
    stationDirectory.expiresAt = Date.now() + 5 * 60 * 1000;
    return stationDirectory.index;
  }).finally(() => { directoryRequest = undefined; });
  return directoryRequest;
}

export function normalizeObservation(metar) {
  if (!metar) return null;
  const numeric = (value) => {
    if (Number.isFinite(value)) return value;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    report: metar.rawOb || null,
    observedAt: metar.reportTime || null,
    temperatureC: numeric(metar.temp),
    dewpointC: numeric(metar.dewp),
    windDirectionDegrees: numeric(metar.wdir),
    windSpeedKnots: numeric(metar.wspd),
    visibilityMiles: numeric(metar.visib),
    visibilityIsAtLeast: typeof metar.visib === "string" && metar.visib.trim().endsWith("+"),
    conditions: metar.wxString || null,
    cloudCover: metar.cover || null,
    flightCategory: metar.fltCat || null,
  };
}

export function normalizeForecast(taf) {
  if (!taf) return null;
  const time = (value) => Number.isFinite(weatherTimestamp(value)) ? new Date(weatherTimestamp(value)).toISOString() : null;
  return { report: taf.rawTAF || null, issuedAt: time(taf.issueTime), validFrom: time(taf.validTimeFrom ?? taf.validFrom), validTo: time(taf.validTimeTo ?? taf.validTo) };
}

export function newestWeatherReport(records, product) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const timestamp = product === "metar" ? "reportTime" : "issueTime";
  return records.reduce((latest, item) => {
    if (!latest) return item;
    const currentTime = weatherTimestamp(item?.[timestamp]);
    const latestTime = weatherTimestamp(latest?.[timestamp]);
    return Number.isFinite(currentTime) && (!Number.isFinite(latestTime) || currentTime > latestTime) ? item : latest;
  }, null);
}

export async function fetchWeatherProduct(station, product) {
  const key = `${product}:${station}`;
  const sharedKey = `weather:${key}`;
  const cached = weatherCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached;
  if (weatherRequests.has(key)) return weatherRequests.get(key);
  const request = (async () => {
    let leaseOwner = false;
    try {
      try {
        const shared = await readProviderState(sharedKey);
        if (shared) {
          weatherCache.set(key, shared);
          return shared;
        }
        leaseOwner = await claimProviderLease(sharedKey, 12_000);
        if (leaseOwner === null) {
          const completed = await waitForProviderState(sharedKey, 11_000);
          if (completed) {
            weatherCache.set(key, completed);
            return completed;
          }
          if (cached) {
            const stale = { ...cached, expiresAt: Date.now() + 30_000, stale: true };
            weatherCache.set(key, stale);
            return stale;
          }
          const unavailable = { report: null, fetchedAt: null, expiresAt: Date.now() + 15_000, stale: true };
          weatherCache.set(key, unavailable);
          return unavailable;
        }
      } catch (error) {
        logServiceError('weather_shared_cache_failed', error);
      }
      const response = await axios.get(`https://aviationweather.gov/api/data/${product}`, {
        params: { ids: station, format: "json", ...(product === "metar" ? { hours: 2 } : {}) },
        timeout: 8000,
        headers: { "User-Agent": USER_AGENT },
      });
      const fetchedAt = new Date().toISOString();
      const entry = {
        report: newestWeatherReport(response.data, product),
        fetchedAt,
        expiresAt: Date.now() + (product === "metar" ? METAR_CACHE_MS : TAF_CACHE_MS),
        stale: false,
      };
      weatherCache.set(key, entry);
      try { await storeProviderState(sharedKey, entry, entry.expiresAt); }
      catch (error) { logServiceError('weather_shared_cache_write_failed', error); }
      return entry;
    } catch (error) {
      logServiceError(`weather_${product}_refresh_failed`, error);
      if (cached) {
        const stale = { ...cached, expiresAt: Date.now() + 30_000, stale: true };
        weatherCache.set(key, stale);
        return stale;
      }
      const unavailable = { report: null, fetchedAt: null, expiresAt: Date.now() + 30_000, stale: true };
      weatherCache.set(key, unavailable);
      return unavailable;
    } finally {
      try { await releaseProviderLease(sharedKey, leaseOwner); }
      catch (error) { logServiceError('weather_lease_release_failed', error); }
      weatherRequests.delete(key);
    }
  })();
  weatherRequests.set(key, request);
  return request;
}

async function stationWeather(iata) {
  const directory = await loadStationDirectory();
  const airport = String(iata || "").toUpperCase();
  const station = directory.get(airport) || FALLBACK_ICAO_BY_IATA[airport];
  if (!station) return { airport: iata, available: false, message: "Weather station mapping is unavailable for this airport." };
  const [metarEntry, tafEntry] = await Promise.all([
    fetchWeatherProduct(station, "metar"),
    fetchWeatherProduct(station, "taf"),
  ]);
  const metar = metarEntry.report;
  const taf = tafEntry.report;
  return {
    airport: iata,
    station,
    available: Boolean(metar || taf),
    observation: normalizeObservation(metar),
    forecast: normalizeForecast(taf),
    metarFetchedAt: metarEntry.fetchedAt,
    tafFetchedAt: tafEntry.fetchedAt,
    metarStale: metarEntry.stale,
    tafStale: tafEntry.stale,
    updatedAt: metarEntry.fetchedAt || tafEntry.fetchedAt,
    message: metar || taf ? null : "No recent METAR or TAF was returned for this airport.",
  };
}

export async function getRouteWeather(origin, destination) {
  const [departure, arrival] = await Promise.all([stationWeather(origin), stationWeather(destination)]);
  return { available: departure.available || arrival.available, source: "AviationWeather.gov", fetchedAt: new Date().toISOString(), airports: [departure, arrival] };
}
