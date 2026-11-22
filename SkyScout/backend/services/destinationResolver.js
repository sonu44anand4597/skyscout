import { readFileSync } from "node:fs";

const airports = JSON.parse(readFileSync(new URL("../data/destination-airports.json", import.meta.url), "utf8"));
const overrides = JSON.parse(readFileSync(new URL("../data/destination-airport-overrides.json", import.meta.url), "utf8"));
const locations = JSON.parse(readFileSync(new URL('../data/airport-locations.json', import.meta.url), 'utf8')).airports;
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const aliases = { "New Delhi": ["Delhi"], Bangalore: ["Bengaluru"], Purnea: ["Purnia"] };

export function resolveDestination(airportCode) {
  const code = String(airportCode || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const record = overrides[code] || airports[code];
  if (!record) return null;
  const city = record.city.trim();
  const countryCode = record.countryCode;
  if (!city || !/^[A-Z]{2}$/.test(countryCode)) return null;
  return {
    airportCode: code,
    airportName: record.airport,
    city,
    countryCode,
    timezone: locations[code]?.timezone || null,
    location: locations[code] ? { latitude: locations[code].latitude, longitude: locations[code].longitude } : null,
    region: locations[code]?.region || null,
    country: countryNames.of(countryCode) || countryCode,
    searchTerms: [city, ...(aliases[city] || [])],
    key: `${countryCode}:${city.toLocaleLowerCase("en")}`,
  };
}
