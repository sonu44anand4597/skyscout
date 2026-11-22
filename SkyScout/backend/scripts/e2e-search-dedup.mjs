import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import dotenv from "dotenv";
import mongoose from "mongoose";
import axios from "axios";
import ProviderLease from "../models/ProviderLease.js";
import ProviderState from "../models/ProviderState.js";
import { searchFlights } from "../services/flightServices.js";

dotenv.config();
const run = promisify(execFile);
const runId = process.env.SKYSCOUT_DEDUP_TEST_ID || randomUUID();
const origin = `Q${runId.slice(0, 2).toUpperCase().replace(/[^A-Z]/g, "A")}`;
const destination = `Z${runId.slice(2, 4).toUpperCase().replace(/[^A-Z]/g, "B")}`;
const date = "2030-01-15";
const cacheKey = JSON.stringify({ origin, destination, date, returnDate: "", tripType: "one-way", legs: [], adults: 1, children: 0, infants: 0, travelClass: 1, currency: "USD" });
const sharedCacheKey = `search:${createHash("sha256").update(cacheKey).digest("hex")}`;
const collection = () => mongoose.connection.collection("e2e_search_dedup");
let trackRefToDelete = null;

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required for the search-deduplication check.");
await mongoose.connect(process.env.MONGODB_URI);
try {
  if (process.argv.includes("--child")) {
    await collection().updateOne({ _id: runId }, { $inc: { ready: 1 } });
    const barrierEnd = Date.now() + 15_000;
    while (Date.now() < barrierEnd && (await collection().findOne({ _id: runId })).ready < 2) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok((await collection().findOne({ _id: runId })).ready >= 2, "Both search processes must reach the barrier.");
    axios.get = async () => {
      await collection().updateOne({ _id: runId }, { $inc: { providerCalls: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 750));
      return { data: { best_flights: [{
        flights: [{ airline: "Test Air", flight_number: "TS 123", departure_airport: { id: origin, name: origin, time: `${date} 09:00` }, arrival_airport: { id: destination, name: destination, time: `${date} 11:00` }, duration: 120, travel_class: "Economy" }],
        total_duration: 120, price: 123,
      }], search_parameters: { currency: "USD" } } };
    };
    const result = await searchFlights({ origin, destination, date, returnDate: "", tripType: "one-way", legs: [], adults: 1, children: 0, infants: 0, travelClass: 1, currency: "USD" });
    assert.equal(result.flights.length, 1);
    assert.ok(result.flights[0].trackRef);
    console.log(JSON.stringify({ cached: result.cached, flights: result.flights.length, trackRef: result.flights[0].trackRef }));
  } else {
    await collection().insertOne({ _id: runId, ready: 0, providerCalls: 0 });
    const script = new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
    const children = await Promise.all([0, 1].map(() => run(process.execPath, [script, "--child"], {
      cwd: process.cwd(), env: { ...process.env, SKYSCOUT_DEDUP_TEST_ID: runId }, timeout: 30_000,
    })));
    const results = children.map(({ stdout }) => JSON.parse(stdout.trim().split("\n").at(-1)));
    trackRefToDelete = results[0].trackRef;
    assert.equal((await collection().findOne({ _id: runId })).providerCalls, 1);
    assert.deepEqual(results.map((item) => item.cached).sort(), [false, true]);
    console.log("Two simultaneous Node processes received one search result from one provider call.");
  }
} finally {
  if (!process.argv.includes("--child")) {
    await collection().deleteOne({ _id: runId });
    await ProviderState.deleteOne({ key: sharedCacheKey });
    if (trackRefToDelete) await ProviderState.deleteOne({ key: `track:${trackRefToDelete}` });
    await ProviderLease.deleteOne({ _id: sharedCacheKey });
  }
  await mongoose.disconnect();
}
