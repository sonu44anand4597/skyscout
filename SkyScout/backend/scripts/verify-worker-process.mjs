// Actual independent worker processes, isolated MongoDB and controlled failure.
// No provider request is made: the worker receives an explicitly empty key.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import connectDB, { closeDatabase } from '../config/database.js';
import mongoose from 'mongoose';
import User from '../models/User.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import Notification from '../models/Notification.js';

const output = process.env.QA_OUTPUT_DIR || '../docs/qa/readiness-2026-11-14';
const evidence = { executedAt: new Date().toISOString(), source: 'Separate worker.js subprocesses and an isolated real MongoDB replica set; no paid providers', checks: {} };
let user;
function worker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker.js', '--once'], { windowsHide: true, env: { ...process.env, SERPAPI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; const deadline = setTimeout(() => { child.kill(); reject(new Error('Worker exceeded its test deadline')); }, 30000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk.toString(); });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); code === 0 ? resolve({ code, logs }) : reject(new Error(`Worker exited ${code}`)); });
  });
}
try {
  // This script is deliberately refused against a non-loopback database.
  assert.match(process.env.MONGODB_URI || '', /^mongodb:\/\/127\.0\.0\.1:27018\/skyscout_readiness_/);
  await connectDB(); assert.equal(mongoose.connection.readyState, 1);
  user = await User.create({ name: 'Worker process QA', email: `${randomUUID()}@example.test`, passwordHash: 'unused-test-account' });
  const base = { userId: user._id, fingerprint: randomUUID(), origin: 'DEL', destination: 'BLR', initialPrice: 6000, currentPrice: 6000, currency: 'INR', nextCheckAt: new Date(0), checkLeaseOwner: 'dead-worker', checkLeaseUntil: new Date(0) };
  const expired = await TrackedFlight.create({ ...base, departureDate: '2020-01-01' });
  const futureDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const future = await TrackedFlight.create({ ...base, fingerprint: randomUUID(), departureDate: futureDate, departureAt: `${futureDate} 10:00`, airline: 'QA fixture', flightNumber: 'QA100' });
  await PriceObservation.create({ userId: user._id, trackedFlightId: future._id, price: 6000, currency: 'INR', observedAt: new Date() });
  const runs = await Promise.all([worker(), worker()]);
  const completed = await TrackedFlight.findById(expired._id).lean();
  const stopped = await TrackedFlight.findById(future._id).lean();
  assert.equal(completed.status, 'completed'); assert.equal(completed.checkLeaseOwner, null);
  assert.equal(stopped.status, 'unresolved'); assert.equal(stopped.checkFailures, 1); assert.equal(stopped.checkLeaseOwner, null);
  assert.equal(stopped.currentPrice, 6000);
  assert.equal(await PriceObservation.countDocuments({ trackedFlightId: future._id }), 1);
  assert.equal(await Notification.countDocuments({ userId: user._id }), 0);
  evidence.checks.expiredLeaseRecovered = true; evidence.checks.concurrentWorkersOneFailure = true; evidence.checks.failedQuotePreservesHistory = true;
  await worker();
  assert.equal((await TrackedFlight.findById(future._id).lean()).checkFailures, 1);
  evidence.checks.restartDoesNotRepeatPermanentFailure = true;
  evidence.processExitCodes = runs.map(run => run.code);
} catch (error) { evidence.failure = error.message; process.exitCode = 1; }
finally {
  if (user) { for (const Model of [PriceObservation, Notification, TrackedFlight]) await Model.deleteMany({ userId: user._id }); await User.deleteOne({ _id: user._id }); }
  await closeDatabase(); await mkdir(output, { recursive: true });
  await writeFile(`${output}/worker-process.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
}
