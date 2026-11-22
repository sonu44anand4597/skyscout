// Real MongoDB/HTTP integration checks with explicitly synthetic fare fixtures.
// No external price provider is called, and only this run's account is removed.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import connectDB, { closeDatabase } from '../config/database.js';
import mongoose from 'mongoose';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import Notification from '../models/Notification.js';
import ProviderLease from '../models/ProviderLease.js';
import { commitMonitoredQuote, processFlight } from '../services/monitoringWorker.js';
import { createNotification } from '../services/notificationService.js';
import { claimProviderLease, releaseProviderLease } from '../services/providerState.js';

const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api';
const evidence = { executedAt: new Date().toISOString(), source: 'Synthetic test fares; real HTTP API and MongoDB transactions', checks: {} };
const email = `concurrency-${randomUUID()}@example.test`;
const password = `Fixture-${randomUUID()}`;
let userId;
let leaseKey;
const request = (path, method = 'GET', body, cookie) => fetch(api + path, { method, headers: { 'X-SkyScout-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
try {
  await connectDB(); assert.equal(mongoose.connection.readyState, 1);
  const registration = await request('/auth/register', 'POST', { name: 'Concurrency fixture', email, password });
  assert.equal(registration.status, 201);
  const account = await registration.json(); userId = account.user.id;
  const cookie = registration.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await request('/auth/register', 'POST', { name: 'Duplicate fixture', email, password })).status, 409);
  assert.equal((await request('/auth/login', 'POST', { email, password: 'wrong-password' })).status, 401);
  evidence.checks.authValidation = true;

  const flight = await TrackedFlight.create({ userId, fingerprint: randomUUID(), origin: 'DEL', destination: 'BLR', departureDate: '2099-01-01', departureAt: '2099-01-01 09:00', tripType: 'one-way', initialPrice: 100, currentPrice: 100, currency: 'INR', checkLeaseOwner: 'new-owner', checkLeaseUntil: new Date(Date.now() - 1000), status: 'active' });
  const observedAt = new Date();
  const observation = { userId, trackedFlightId: flight._id, price: 80, currency: 'INR', observedAt, quoteKey: `fixture:${randomUUID()}` };
  assert.equal(await commitMonitoredQuote(flight, observation, { currentPrice: 80 }), false, 'an expired lease must be rejected even before another worker claims it');
  assert.equal(await PriceObservation.countDocuments({ trackedFlightId: flight._id }), 0);
  flight.checkLeaseUntil = new Date(Date.now() + 600000);
  await flight.save();
  evidence.checks.expiredUnreclaimedLeaseFenced = true;
  assert.equal(await commitMonitoredQuote({ ...flight.toObject(), checkLeaseOwner: 'expired-owner' }, observation, { currentPrice: 80 }), false);
  assert.equal(await PriceObservation.countDocuments({ trackedFlightId: flight._id }), 0);
  const writes = await Promise.all([commitMonitoredQuote(flight, observation, { currentPrice: 80 }), commitMonitoredQuote(flight, observation, { currentPrice: 80 })]);
  assert.equal(writes.filter(Boolean).length, 1);
  assert.equal(await PriceObservation.countDocuments({ trackedFlightId: flight._id }), 1);
  assert.equal((await TrackedFlight.findById(flight._id)).currentPrice, 80);
  assert.equal(await Notification.countDocuments({ dedupeKey: `drop:${observation.quoteKey}` }), 1, 'price alert must commit in the same transaction as its quote');
  evidence.checks.ownerFencingAndAtomicQuote = true;
  evidence.checks.priceAlertCommittedWithQuote = true;

  const notification = { userId, trackedFlightId: flight._id, type: 'PRICE_DROP', title: 'Synthetic concurrency test', message: 'Controlled fixture, not a provider quote.', dedupeKey: `fixture:${randomUUID()}` };
  await Promise.all(Array.from({ length: 4 }, () => createNotification(notification)));
  assert.equal(await Notification.countDocuments({ dedupeKey: notification.dedupeKey }), 1);
  evidence.checks.notificationDeduplication = true;

  leaseKey = `qa:${randomUUID()}`;
  const claims = await Promise.all(Array.from({ length: 4 }, () => claimProviderLease(leaseKey)));
  assert.equal(claims.filter((claim) => typeof claim === 'string').length, 1);
  await releaseProviderLease(leaseKey, 'wrong-owner');
  assert.equal(await claimProviderLease(leaseKey), null);
  const formerOwner = claims.find(Boolean);
  await ProviderLease.updateOne({ _id: leaseKey, owner: formerOwner }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
  const recoveredOwner = await claimProviderLease(leaseKey);
  assert.equal(typeof recoveredOwner, 'string');
  await releaseProviderLease(leaseKey, formerOwner);
  assert.equal(await claimProviderLease(leaseKey), null, 'the former owner must not release the recovered lease');
  await releaseProviderLease(leaseKey, recoveredOwner);
  evidence.checks.exclusiveDistributedLease = true;
  evidence.checks.expiredProviderLeaseRecovery = true;

  await Promise.all([TrackedFlight.init(), Notification.init()]);
  evidence.databaseQueries = {};
  for (const [name, query] of [
    ['trackedFlightPage', TrackedFlight.find({ userId }).sort({ _id: -1 }).limit(51)],
    ['notificationPage', Notification.find({ userId }).sort({ _id: -1 }).limit(51)],
  ]) {
    const plan = await query.explain('executionStats');
    const statistics = plan.executionStats;
    evidence.databaseQueries[name] = { returned: statistics.nReturned, documentsExamined: statistics.totalDocsExamined, keysExamined: statistics.totalKeysExamined, databaseExecutionMilliseconds: statistics.executionTimeMillis, winningPlan: plan.queryPlanner.winningPlan };
  }

  await processFlight({ ...flight.toObject(), checkLeaseOwner: null }, { searchFlights: async () => { throw Object.assign(new Error('Controlled invalid key fixture'), { providerCode: 'invalid_key' }); }, logError: () => {} });
  const stopped = await TrackedFlight.findById(flight._id);
  assert.equal(stopped.status, 'unresolved'); assert.equal(stopped.nextCheckAt, null);
  evidence.checks.permanentProviderErrorStopsRetry = true;

  await request(`/tracked-flights/${flight._id}`, 'DELETE', undefined, cookie);
  await createNotification({ ...notification, dedupeKey: `${notification.dedupeKey}:after-delete` });
  assert.equal(await Notification.countDocuments({ trackedFlightId: flight._id }), 0);
  assert.equal(await PriceObservation.countDocuments({ trackedFlightId: flight._id }), 0);
  evidence.checks.noOrphanNotificationAfterDelete = true;
  await AuthSession.updateMany({ userId }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await request('/auth/me', 'GET', undefined, cookie)).status, 401);
  evidence.checks.expiredSessionRejected = true;
  console.log(JSON.stringify(evidence));
} catch (error) { evidence.failure = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  if (userId) { for (const Model of [PriceObservation, Notification, TrackedFlight, AuthSession]) await Model.deleteMany({ userId }); await User.deleteOne({ _id: userId }); }
  if (leaseKey) await ProviderLease.deleteOne({ _id: leaseKey });
  await closeDatabase();
  const evidenceDirectory = process.env.QA_OUTPUT_DIR || process.env.QA_ARTIFACT_DIR || `../docs/qa/readiness-${new Date().toISOString().slice(0, 10)}`;
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(`${evidenceDirectory}/backend-concurrency.json`, JSON.stringify(evidence, null, 2));
}
