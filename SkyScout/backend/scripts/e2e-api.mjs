import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";

import AuthSession from "../models/AuthSession.js";
import DisruptionPrediction from "../models/DisruptionPrediction.js";
import Notification from "../models/Notification.js";
import PriceObservation from "../models/PriceObservation.js";
import FareIntelligenceAnalysis from "../models/FareIntelligenceAnalysis.js";
import TrackedFlight from "../models/TrackedFlight.js";
import User from "../models/User.js";
import { processFlight } from "../services/monitoringWorker.js";
import { getDelayPrediction } from "../services/predictionService.js";
import { recordMarketQuote } from '../services/fareMarket.js';
import connectDB, { closeDatabase } from '../config/database.js';

dotenv.config();

const API_URL = process.env.E2E_API_URL || "http://127.0.0.1:5000/api";
const runId = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const password = `SkyScout-e2e-${randomBytes(12).toString("base64url")}`;
const createdUserIds = [];

function cookieFrom(response) {
  const header = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "";
  const cookie = header.split(";", 1)[0];
  assert.match(cookie, /^skyscout_session=/, "authentication response must set the session cookie");
  return cookie;
}

async function request(path, { method = "GET", cookie, body } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'X-SkyScout-Request': '1',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); }
  catch { throw new Error(`${method} ${path} returned ${response.status} ${response.headers.get("content-type") || "unknown content type"} instead of JSON: ${raw.slice(0, 80)}`); }
  return { response, payload };
}

async function register(label) {
  const email = `skyscout-e2e-${label}-${runId}@example.test`;
  const result = await request("/auth/register", { method: "POST", body: { name: `E2E ${label}`, email, password } });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  createdUserIds.push(new mongoose.Types.ObjectId(result.payload.user.id));
  return { ...result.payload.user, cookie: cookieFrom(result.response) };
}

async function cleanup() {
  if (!createdUserIds.length) return;
  await Promise.all([
    PriceObservation.deleteMany({ userId: { $in: createdUserIds } }),
    FareIntelligenceAnalysis.deleteMany({ userId: { $in: createdUserIds } }),
    Notification.deleteMany({ userId: { $in: createdUserIds } }),
    DisruptionPrediction.deleteMany({ userId: { $in: createdUserIds } }),
    TrackedFlight.deleteMany({ userId: { $in: createdUserIds } }),
    AuthSession.deleteMany({ userId: { $in: createdUserIds } }),
  ]);
  await User.deleteMany({ _id: { $in: createdUserIds } });
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required for the live API E2E check.");
  await connectDB();
  assert.equal(mongoose.connection.readyState, 1, 'MongoDB must be reachable for live API E2E');
  try {
    const owner = await register("owner");
    const outsider = await register("outsider");
    const ownerId = new mongoose.Types.ObjectId(owner.id);
    const departureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [flight] = await TrackedFlight.create([{
      userId: ownerId,
      fingerprint: randomBytes(32).toString("hex"),
      origin: "JFK",
      destination: "LAX",
      departureDate,
      departureAt: `${departureDate}T09:00:00-05:00`,
      airline: "Example Air",
      flightNumber: "EX 100",
      segments: [{ from: "JFK", to: "LAX", flightNumber: "EX 100", durationMinutes: 360 }],
      initialPrice: 500,
      currentPrice: 450,
      currency: "USD",
      targetPrice: 425,
      status: "paused",
    }]);
    await Promise.all([
      PriceObservation.create({ userId: ownerId, trackedFlightId: flight._id, price: 500, currency: "USD" }),
      Notification.create({ userId: ownerId, trackedFlightId: flight._id, type: "PRICE_DROP", title: "E2E price drop", message: "Fixture", dedupeKey: `e2e:${runId}`, read: false }),
      DisruptionPrediction.create({ userId: ownerId, trackedFlightId: flight._id, modelVersion: "e2e-model", probability: 0.10, riskLevel: "low", generatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000), inputSummary: { flightLeg: { origin: "JFK", destination: "LAX", flightNumber: "EX 100", departureAt: `${departureDate}T09:00:00-05:00`, durationMinutes: 360, stops: 0 } } }),
    ]);

    const predictionResult = await getDelayPrediction(flight, {
      requestPrediction: async () => ({ data: { modelVersion: "e2e-model", probability: 0.42, riskLevel: "medium", generatedAt: new Date().toISOString(), scope: "E2E fixture", target: "Arrival delay >= 15 minutes", metrics: {}, evaluation: {}, riskThresholds: { medium: 0.2, high: 0.5 } } }),
    });
    assert.equal(predictionResult.prediction.riskLevel, "medium");
    assert.equal(await Notification.countDocuments({ userId: ownerId, type: "DISRUPTION_RISK_CHANGE" }), 1);

    await processFlight(flight, { searchFlights: async () => ({ flights: [] }), logError: () => {} });
    assert.equal(await Notification.countDocuments({ userId: ownerId, type: "CHECK_UNRESOLVED" }), 1);

    const profile = await request("/auth/me", { cookie: owner.cookie });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.payload.user.email, owner.email);
    assert.match(profile.response.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/);
    assert.equal(profile.response.headers.get("cache-control"), "no-store");
    assert.equal(profile.response.headers.has("x-powered-by"), false);

    const ownerFlights = await request("/tracked-flights", { cookie: owner.cookie });
    assert.equal(ownerFlights.response.status, 200);
    assert.equal(ownerFlights.payload.data.length, 1);
    assert.equal(ownerFlights.payload.data[0].latestPrediction.riskLevel, "medium");
    assert.equal((await request(`/tracked-flights/${flight.id}`, { cookie: owner.cookie })).payload.data._id, flight.id);

    const ownerHistory = await request(`/tracked-flights/${flight.id}/history`, { cookie: owner.cookie });
    assert.equal(ownerHistory.response.status, 200);
    assert.equal(ownerHistory.payload.data.length, 1);

    const ownerFare = await request(`/tracked-flights/${flight.id}/fare-intelligence`, { cookie: owner.cookie });
    assert.equal(ownerFare.response.status, 200);
    assert.equal(ownerFare.payload.baseline.route.origin, "JFK");
    assert.equal(ownerFare.payload.baseline.route.destination, "LAX");
    assert.equal(ownerFare.payload.baseline.currency, "USD");
    assert.equal(ownerFare.payload.baseline.currentFare, 500);
    assert.equal(ownerFare.payload.baseline.observationCount, 1);

    // A manual/comparable-market refresh must create the same durable alerts as
    // monitoring. These are controlled quotes; no paid provider is called here.
    const quotedAt = new Date().toISOString();
    await recordMarketQuote(flight, { price: 400, currency: 'USD' }, quotedAt);
    await recordMarketQuote(flight, { price: 400, currency: 'USD' }, quotedAt);
    assert.equal((await TrackedFlight.findById(flight._id).lean()).currentPrice, 400);
    assert.equal(await PriceObservation.countDocuments({ trackedFlightId: flight._id }), 2);
    assert.equal(await Notification.countDocuments({ trackedFlightId: flight._id, type: 'TARGET_REACHED' }), 1);
    assert.equal(await Notification.countDocuments({ trackedFlightId: flight._id, type: 'PRICE_DROP' }), 2, 'one original fixture and one deduplicated drop');

    const pausedRefresh = await request(`/tracked-flights/${flight.id}/refresh`, { method: 'POST', cookie: owner.cookie });
    assert.equal(pausedRefresh.response.status, 409);
    await TrackedFlight.updateOne({ _id: flight._id }, { $set: { checkFailures: 6 } });
    const resumed = await request(`/tracked-flights/${flight.id}`, { method: 'PATCH', cookie: owner.cookie, body: { status: 'active' } });
    assert.equal(resumed.payload.data.checkFailures, 0);
    const queued = await request(`/tracked-flights/${flight.id}/refresh`, { method: 'POST', cookie: owner.cookie });
    assert.equal(queued.response.status, 202);
    assert.equal(queued.payload.data.currentPrice, 400, 'queueing must not invent a new quote');
    await TrackedFlight.updateOne({ _id: flight._id }, { $set: { checkLeaseOwner: 'e2e-running-worker', checkLeaseUntil: new Date(Date.now() + 60000) } });
    assert.equal((await request(`/tracked-flights/${flight.id}/refresh`, { method: 'POST', cookie: owner.cookie })).response.status, 409);

    for (const operation of [
      () => request(`/tracked-flights/${flight.id}/history`, { cookie: outsider.cookie }),
      () => request(`/tracked-flights/${flight.id}`, { cookie: outsider.cookie }),
      () => request(`/tracked-flights/${flight.id}/fare-intelligence`, { cookie: outsider.cookie }),
      () => request(`/tracked-flights/${flight.id}`, { method: "PATCH", cookie: outsider.cookie, body: { targetPrice: 1 } }),
      () => request(`/tracked-flights/${flight.id}`, { method: "DELETE", cookie: outsider.cookie }),
      () => request(`/tracked-flights/${flight.id}/refresh`, { method: 'POST', cookie: outsider.cookie }),
    ]) {
      const denied = await operation();
      assert.equal(denied.response.status, 404);
    }

    const outsiderNotifications = await request("/tracked-flights/notifications", { cookie: outsider.cookie });
    assert.deepEqual(outsiderNotifications.payload.data, []);
    const notification = await Notification.findOne({ userId: ownerId }).lean();
    await request(`/tracked-flights/notifications/read/${notification._id}`, { method: "PATCH", cookie: outsider.cookie });
    assert.equal((await Notification.findById(notification._id).lean()).read, false);

    await request("/tracked-flights/notifications/read/all", { method: "PATCH", cookie: owner.cookie });
    assert.equal((await Notification.findById(notification._id).lean()).read, true);

    const removed = await request(`/tracked-flights/${flight.id}`, { method: "DELETE", cookie: owner.cookie });
    assert.equal(removed.response.status, 200);
    assert.equal(await PriceObservation.countDocuments({ trackedFlightId: flight._id }), 0);
    assert.equal(await FareIntelligenceAnalysis.countDocuments({ trackedFlightId: flight._id }), 0);
    assert.equal(await Notification.countDocuments({ trackedFlightId: flight._id }), 0);
    assert.equal(await DisruptionPrediction.countDocuments({ trackedFlightId: flight._id }), 0);

    const logout = await request("/auth/logout", { method: "POST", cookie: owner.cookie });
    assert.equal(logout.response.status, 200);
    const afterLogout = await request("/auth/me", { cookie: owner.cookie });
    assert.equal(afterLogout.response.status, 401);
    await AuthSession.updateMany({ userId: outsider.id }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await request('/auth/me', { cookie: outsider.cookie })).response.status, 401);
    const expiredLogout = await request('/auth/logout', { method: 'POST', cookie: outsider.cookie });
    assert.equal(expiredLogout.response.status, 200);
    assert.match(expiredLogout.response.headers.get('set-cookie'), /Max-Age=0/);
    console.log("API/database E2E passed: auth, ownership, history, market alert atomicity/deduplication, manual refresh leases, notifications, cascade deletion, live/expired logout. Provider quotes are controlled fixtures.");
  } finally {
    await cleanup();
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
