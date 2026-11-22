import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";
import ProviderState from "../models/ProviderState.js";
import ProviderLease from "../models/ProviderLease.js";
import RateLimitBucket from "../models/RateLimitBucket.js";
import { claimProviderLease, readProviderState, releaseProviderLease, storeProviderState } from "../services/providerState.js";
import { getTrackedFlightSelection } from "../services/flightServices.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

dotenv.config();
const run = promisify(execFile);
const key = process.env.SKYSCOUT_SHARED_STATE_TEST_KEY || `e2e:${randomUUID()}`;
const scope = `e2e:${key}`;
const rateAddress = "198.51.100.42";
const rateWindowMs = 600_000;
const windowStart = Math.floor(Date.now() / rateWindowMs) * rateWindowMs;
const rateId = `${createHash("sha256").update(`${scope}:${rateAddress}`).digest("hex")}:${windowStart}`;
const leaseKey = `search:${key}`;

async function checkLimit() {
  const limiter = createRateLimiter({ limit: 1, windowMs: rateWindowMs, scope, message: "Limited" });
  let passed = false;
  let denied = null;
  await limiter({ ip: rateAddress }, { status(code) { denied = code; return this; }, json() { return this; } }, () => { passed = true; });
  return { passed, denied };
}

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required for shared-state verification.");
await mongoose.connect(process.env.MONGODB_URI);
try {
  if (process.argv.includes("--reader")) {
    assert.deepEqual(await readProviderState(key), { flight: "AA 100", fare: 321 });
    assert.equal((await getTrackedFlightSelection(key)).flight.flightNumber, "AA 100");
    assert.deepEqual(await checkLimit(), { passed: false, denied: 429 });
    assert.equal(await claimProviderLease(leaseKey), null, "A second process cannot claim the active search lease.");
    console.log("Separate process read the tracking reference and observed the shared rate limit and lease.");
  } else {
    const expiresAt = Date.now() + 60_000;
    await storeProviderState(key, { flight: "AA 100", fare: 321 }, expiresAt);
    await storeProviderState(`track:${key}`, { flight: { flightNumber: "AA 100" }, context: {}, expiresAt }, expiresAt);
    assert.deepEqual(await checkLimit(), { passed: true, denied: null });
    const firstOwner = await claimProviderLease(leaseKey);
    assert.equal(typeof firstOwner, "string");
    const child = await run(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""), "--reader"], {
      cwd: process.cwd(),
      env: { ...process.env, SKYSCOUT_SHARED_STATE_TEST_KEY: key },
      timeout: 30_000,
    });
    assert.match(child.stdout, /tracking reference and observed the shared rate limit and lease/);
    await releaseProviderLease(leaseKey, firstOwner);
    const nextOwner = await claimProviderLease(leaseKey);
    assert.equal(typeof nextOwner, "string", "The lease can be claimed after its owner releases it.");
    await releaseProviderLease(leaseKey, nextOwner);
    const stored = await ProviderState.findOne({ key }).lean();
    assert.ok(stored.expiresAt > new Date());
    console.log("Shared references, atomic rate limiting and search leases passed across processes.");
  }
} finally {
  if (!process.argv.includes("--reader")) {
    await ProviderState.deleteOne({ key });
    await ProviderState.deleteOne({ key: `track:${key}` });
    await RateLimitBucket.deleteOne({ _id: rateId });
    await ProviderLease.deleteOne({ _id: leaseKey });
  }
  await mongoose.disconnect();
}
