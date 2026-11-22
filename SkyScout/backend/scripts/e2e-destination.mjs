import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";
import AuthSession from "../models/AuthSession.js";
import TrackedFlight from "../models/TrackedFlight.js";
import User from "../models/User.js";
import { resolveDestination } from "../services/destinationResolver.js";

dotenv.config();
const api = process.env.E2E_API_URL || "http://127.0.0.1:5000/api";
const suffix = randomBytes(6).toString("hex");
const users = [];
const flights = [];
const destinationCode = process.env.E2E_DESTINATION_CODE || "CDG";
const originCode = process.env.E2E_ORIGIN_CODE || "LAX";
const expectedDestination = resolveDestination(destinationCode);
assert.ok(expectedDestination, `Unknown E2E destination: ${destinationCode}`);

async function request(path, cookie) {
  const response = await fetch(`${api}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: response.status, data: await response.json() };
}

async function register(label) {
  const response = await fetch(`${api}/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-SkyScout-Request": "1" },
    body: JSON.stringify({ name: `Destination E2E ${label}`, email: `destination-${label}-${suffix}@example.test`, password: `Test-${randomBytes(15).toString("base64url")}` }),
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  users.push(new mongoose.Types.ObjectId(data.user.id));
  return { id: data.user.id, cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const owner = await register("owner");
  const outsider = await register("outsider");
  const departureDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const flight = await TrackedFlight.create({
    userId: owner.id, fingerprint: randomBytes(32).toString("hex"),
    origin: originCode, destination: destinationCode, departureDate,
    airline: process.env.E2E_CHECK_INDIAN_PREDICTION ? "IndiGo" : "E2E itinerary", flightNumber: process.env.E2E_CHECK_INDIAN_PREDICTION ? "6E 123" : "E2E 1", segments: [{ from: originCode, to: destinationCode }],
    initialPrice: 1000, currentPrice: 1000, currency: "INR", status: "paused",
  });
  flights.push(flight._id);

  const denied = await request(`/tracked-flights/${flight.id}/destination-intelligence`, outsider.cookie);
  assert.equal(denied.status, 404);
  const unauthenticated = await request(`/tracked-flights/${flight.id}/destination-intelligence`);
  assert.equal(unauthenticated.status, 401);

  const first = await request(`/tracked-flights/${flight.id}/destination-intelligence`, owner.cookie);
  assert.equal(first.status, 200);
  assert.equal(first.data.destination?.city, expectedDestination.city);
  assert.equal(first.data.destination?.country, expectedDestination.country);
  assert.equal(first.data.destination?.airportCode, destinationCode);
  assert.equal(first.data.available, true, first.data.message);
  for (const event of first.data.events) {
    assert.ok(event.sources.length >= 2 || event.sources.some((source) => source.tier === "official"));
    for (const source of event.sources) assert.match(source.url, /^https:\/\//);
  }
  const second = await request(`/tracked-flights/${flight.id}/destination-intelligence`, owner.cookie);
  assert.equal(second.data.checkedAt, first.data.checkedAt, "fresh destination cache should be reused");
  if (process.env.E2E_CHECK_INDIAN_PREDICTION) {
    const estimate = await request(`/tracked-flights/${flight.id}/prediction`, owner.cookie);
    assert.equal(estimate.status, 200);
    assert.equal(estimate.data.available, false);
    assert.equal(estimate.data.region, "IN");
    assert.equal(estimate.data.prediction, undefined);
    assert.equal(estimate.data.operationalContext?.usedInPrediction, false);
    assert.ok(Number.isFinite(estimate.data.operationalContext?.otpPercent));
  }
  const watchlist = await request("/tracked-flights", owner.cookie);
  assert.equal(watchlist.status, 200);
  assert.equal(watchlist.data.data.length, 1);
  console.log(JSON.stringify({ result: "passed", destination: first.data.destination.city, qualifyingEvents: first.data.events.length, cacheReused: true, ownershipDenied: true }));
} finally {
  if (flights.length) await TrackedFlight.deleteMany({ _id: { $in: flights } });
  if (users.length) {
    await AuthSession.deleteMany({ userId: { $in: users } });
    await User.deleteMany({ _id: { $in: users } });
  }
  await mongoose.disconnect();
}
