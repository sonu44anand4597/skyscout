import { createHash } from 'node:crypto';
import { airportByCode, airportCatalogInfo, normalizeAirport, normalizeAirportQuery, rankAirports, searchAirportCatalog } from './airportCatalog.js';
import { serpApiRequest, invalidProviderResponse } from './serpApi.js';
import { readProviderState, storeProviderState } from './providerState.js';

export function parseAirportSuggestions(data) {
  if (!data || !Array.isArray(data.suggestions)) throw invalidProviderResponse();
  const airports = [];
  for (const group of data.suggestions) {
    if (!group || typeof group !== 'object' || (group.airports !== undefined && !Array.isArray(group.airports))) throw invalidProviderResponse();
    for (const item of group.airports || []) {
      const known = airportByCode.get(String(item?.id || '').toUpperCase());
      const airport = normalizeAirport(known || { ...item, city: item?.city || group.name?.split(',')[0] });
      if (airport) airports.push(airport);
    }
  }
  return airports;
}

export function createAirportSearch({ provider = serpApiRequest, read = readProviderState, store = storeProviderState, now = Date.now, preferCatalog = true } = {}) {
  const cache = new Map(); const pending = new Map();
  return async (text) => {
    const query = normalizeAirportQuery(text);
    if (query.length < 2 || query.length > 80) throw Object.assign(new Error('Enter between 2 and 80 characters for an airport search.'), { status: 400 });
    const key = `airport:v3:${preferCatalog ? 'catalog' : 'provider'}:${createHash('sha256').update(query).digest('hex')}`;
    const local = cache.get(key);
    if (local?.expiresAt > now()) return { ...local.result, cached: true };
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const shared = await read(key).catch(() => null);
      if (shared?.expiresAt > now() && Array.isArray(shared.result?.items)) return { ...shared.result, cached: true };
      const catalog = searchAirportCatalog(query);
      let result; let ttl;
      if (preferCatalog && catalog.length) {
        result = { items: catalog, source: 'catalog', providerStatus: 'not_requested', catalog: airportCatalogInfo, cached: false };
        ttl = 24 * 60 * 60000;
      } else try {
        const response = await provider({ engine: 'google_flights_autocomplete', q: query, gl: 'in', hl: 'en', exclude_regions: true });
        const items = rankAirports([...catalog, ...parseAirportSuggestions(response.data)], query);
        result = { items, source: 'provider_and_catalog', providerStatus: 'ok', catalog: airportCatalogInfo, cached: false };
        ttl = 10 * 60000;
      } catch (error) {
        result = { items: catalog, source: 'catalog_fallback', providerStatus: error.providerCode || 'provider_unavailable', catalog: airportCatalogInfo,
          message: catalog.length ? 'Airport search is having trouble. Showing available local results.' : 'Airport search is having trouble. No matching airports are available in the local catalog; try another city or code.', cached: false };
        ttl = 60000;
      }
      const entry = { result, expiresAt: now() + ttl };
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
      await store(key, entry, entry.expiresAt).catch(() => {});
      return result;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}
export const searchAirportSuggestions = createAirportSearch();
