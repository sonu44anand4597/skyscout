import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { searchFlights } from "../services/flightServices.js";

dotenv.config();
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
const [origin, destination, date] = process.argv.slice(2);
if (!/^[A-Z]{3}$/.test(origin || "") || !/^[A-Z]{3}$/.test(destination || "") || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
  throw new Error("Usage: node scripts/check-shared-search.mjs ORIGIN DESTINATION YYYY-MM-DD");
}
await mongoose.connect(process.env.MONGODB_URI);
try {
  const result = await searchFlights({
    origin, destination, date, returnDate: "",
    tripType: "one-way", legs: [], adults: 1, children: 0, infants: 0,
    travelClass: 1, currency: "INR",
  });
  assert.equal(result.cached, true, "The API process should have saved a shared search result.");
  assert.ok(result.flights.length > 0);
  assert.ok(result.flights[0].trackRef);
  console.log(`Separate process loaded ${result.flights.length} flights from the shared search cache.`);
} finally {
  await mongoose.disconnect();
}
