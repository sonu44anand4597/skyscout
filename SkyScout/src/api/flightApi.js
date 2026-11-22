import { apiRequest } from "./client.js";

export async function searchFlights(searchData, { signal } = {}) {
  const params = new URLSearchParams({
    origin: searchData.origin,
    destination: searchData.destination,
    date: searchData.departure,
    tripType: searchData.tripType || "one-way",
    adults: String(searchData.adults ?? 1),
    children: String(searchData.children ?? 0),
    infants: String(searchData.infants ?? 0),
    travelClass: String(searchData.travelClass ?? 1),
    currency: searchData.currency || 'INR',
  });
  if (searchData.tripType === "round-trip") params.set("returnDate", searchData.returnDate);
  if (searchData.tripType === "multi-city") params.set("legs", JSON.stringify(searchData.legs || []));

  return apiRequest(`/flights/search?${params}`, { signal, timeoutMs: 45000 });
}
