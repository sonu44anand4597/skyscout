import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import connectDB, { closeDatabase } from '../config/database.js';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import DisruptionPrediction from '../models/DisruptionPrediction.js';
import Notification from '../models/Notification.js';

const evidence = { executedAt: new Date().toISOString(), source: 'Real installed BTS LSTM; synthetic schedule inputs, not a live flight quote' };
const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api';
const output = process.env.QA_OUTPUT_DIR || '../docs/qa/production-2026-10-28';
let userId;
try {
  const health = await (await fetch(`${process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001'}/health`)).json();
  assert.equal(health.available, true); evidence.health = health;
  const invalid = await fetch(`${process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001'}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'invalid' }) });
  assert.equal(invalid.status, 422); evidence.invalidInputStatus = invalid.status;
  await connectDB();
  const registration = await fetch(`${api}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SkyScout-Request': '1' }, body: JSON.stringify({ name: 'Model verification fixture', email: `model-${randomUUID()}@example.test`, password: randomUUID() }) });
  assert.equal(registration.status, 201);
  userId = (await registration.json()).user.id;
  const cookie = registration.headers.getSetCookie()[0].split(';')[0];
  const date = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const flight = await TrackedFlight.create({ userId, fingerprint: randomUUID(), origin: 'JFK', destination: 'LAX', departureDate: date, departureAt: `${date}T09:00:00-05:00`, airline: 'American Airlines', flightNumber: 'AA 100', tripType: 'one-way', segments: [{ durationMinutes: 360 }], initialPrice: 100, currentPrice: 100, currency: 'USD', status: 'paused' });
  const result = await (await fetch(`${api}/tracked-flights/${flight._id}/prediction`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) })).json();
  assert.equal(result.available, true);
  assert.ok(Number.isFinite(result.prediction.probability) && result.prediction.probability >= 0 && result.prediction.probability <= 1);
  assert.equal(result.prediction.modelVersion, health.regions.US);
  assert.match(result.prediction.inputSummary.target, /arrival|Arr/i);
  evidence.backendPrediction = { available: true, modelVersion: result.prediction.modelVersion, riskLevel: result.prediction.riskLevel, probability: result.prediction.probability, target: result.prediction.inputSummary.target };
  await TrackedFlight.updateOne({ _id: flight._id }, { $set: { origin: 'DEL', destination: 'BLR', airline: 'IndiGo', flightNumber: '6E 100' } });
  const india = await (await fetch(`${api}/tracked-flights/${flight._id}/prediction`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) })).json();
  assert.equal(india.available, false); assert.equal(india.region, 'IN'); assert.equal(india.prediction, undefined);
  evidence.indiaUnsupported = true;
  console.log(JSON.stringify(evidence));
} catch (error) { evidence.failure = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  if (userId) { for (const Model of [DisruptionPrediction, Notification, TrackedFlight, AuthSession]) await Model.deleteMany({ userId }); await User.deleteOne({ _id: userId }); }
  await closeDatabase();
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/model.json`, JSON.stringify(evidence, null, 2));
}
