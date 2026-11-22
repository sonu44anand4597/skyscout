import { readFileSync } from 'node:fs';

const snapshot = JSON.parse(readFileSync(new URL('../data/airport-search.json', import.meta.url), 'utf8'));
const countries = new Intl.DisplayNames(['en'], { type: 'region' });
export const normalizeAirportQuery = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

export function normalizeAirport(record) {
  const iata = String(record?.iata || record?.code || record?.id || '').trim().toUpperCase();
  const name = String(record?.name || record?.airport || '').trim().slice(0, 180);
  const city = String(record?.city || '').trim().slice(0, 100);
  if (!/^[A-Z]{3}$/.test(iata) || name.length < 2 || !city) return null;
  const countryCode = /^[A-Z]{2}$/.test(record.countryCode || '') ? record.countryCode : null;
  return { iata, name, city, countryCode, country: countryCode ? countries.of(countryCode) : null,
    displayName: `${city} (${iata})`, code: iata, airport: name, timezone: record.timezone || null,
    aliases: Array.isArray(record.aliases) ? record.aliases.filter((value) => typeof value === 'string').slice(0, 12) : [],
  };
}
const catalog = snapshot.airports.map(normalizeAirport).filter(Boolean);
export const airportByCode = new Map(catalog.map((airport) => [airport.iata, airport]));
export const airportCatalogInfo = { source: snapshot.source, derivedAt: snapshot.derivedAt, inputSha256: snapshot.inputSha256, count: catalog.length };
const indexed = catalog.map((airport) => ({ airport, terms: [airport.iata, airport.city, airport.name, ...airport.aliases].map(normalizeAirportQuery) }));

function relevance(airport, query, terms = [airport.iata, airport.city, airport.name, ...airport.aliases].map(normalizeAirportQuery)) {
  const code = airport.iata.toLowerCase();
  if (query === code) return 1000;
  if (terms.includes(query)) return 800;
  if (terms.some((term) => term.startsWith(query))) return 600;
  if (query.split(' ').every((token) => terms.some((term) => term.includes(token)))) return 400;
  return 0;
}
export function rankAirports(airports, text, limit = 12) {
  const query = normalizeAirportQuery(text);
  const unique = new Map();
  for (const airport of airports) if (airport && !unique.has(airport.iata)) unique.set(airport.iata, airport);
  return [...unique.values()].map((airport) => ({ airport, score: relevance(airport, query) }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score
      || Number(b.airport.countryCode === 'IN') - Number(a.airport.countryCode === 'IN')
      || Number(b.airport.countryCode === 'GB' && query === 'london') - Number(a.airport.countryCode === 'GB' && query === 'london')
      || a.airport.iata.localeCompare(b.airport.iata)).slice(0, limit).map((item) => item.airport);
}
export function searchAirportCatalog(text, limit = 12) {
  const query = normalizeAirportQuery(text);
  if (query.length < 2 || query.length > 80) return [];
  const matches = indexed.filter(({ airport, terms }) => relevance(airport, query, terms) > 0).map(({ airport }) => airport);
  return rankAirports(matches, query, limit);
}
