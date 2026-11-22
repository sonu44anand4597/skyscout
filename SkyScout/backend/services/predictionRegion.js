import { resolveDestination } from "./destinationResolver.js";

const INDIAN_AIRLINES = new Map([
  ["6E", "6E"], ["INDIGO", "6E"], ["INTERGLOBE AVIATION", "6E"],
  ["AI", "AI"], ["AIR INDIA", "AI"],
  ["IX", "IX"], ["AIR INDIA EXPRESS", "IX"],
  ["QP", "QP"], ["AKASA AIR", "QP"], ["AKASA", "QP"],
  ["SG", "SG"], ["SPICEJET", "SG"],
  ["9I", "9I"], ["ALLIANCE AIR", "9I"],
]);

export function normalizeIndianAirline(name, flightNumber) {
  const code = String(flightNumber || "").trim().toUpperCase().match(/^([A-Z0-9]{2})\s*\d/ )?.[1];
  if (code && INDIAN_AIRLINES.has(code)) return INDIAN_AIRLINES.get(code);
  return INDIAN_AIRLINES.get(String(name || "").trim().toUpperCase().replace(/\s+/g, " ")) || null;
}

export function predictionRegion(origin, destination) {
  const from = resolveDestination(origin)?.countryCode;
  const to = resolveDestination(destination)?.countryCode;
  if (from === "IN" && to === "IN") return "IN";
  if (from === "US" && to === "US") return "US";
  return null;
}
