import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import ProviderState from "../models/ProviderState.js";
import ProviderLease from "../models/ProviderLease.js";

export function providerStateAvailable() {
  return mongoose.connection.readyState === 1;
}

export async function storeProviderState(key, payload, expiresAt) {
  if (!providerStateAvailable()) return;
  await ProviderState.updateOne({ key }, { $set: { payload, expiresAt: new Date(expiresAt) } }, { upsert: true });
}

export async function storeProviderStates(entries) {
  if (!providerStateAvailable() || entries.length === 0) return;
  await ProviderState.bulkWrite(entries.map(({ key, payload, expiresAt }) => ({
    updateOne: { filter: { key }, update: { $set: { payload, expiresAt: new Date(expiresAt) } }, upsert: true },
  })));
}

export async function readProviderState(key) {
  if (!providerStateAvailable()) return null;
  const record = await ProviderState.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
  return record?.payload || null;
}

export async function claimProviderLease(key, durationMs = 30_000) {
  if (!providerStateAvailable()) return false;
  const owner = randomUUID();
  const now = new Date();
  try {
    const lease = await ProviderLease.findOneAndUpdate(
      { _id: key, leaseUntil: { $lte: now } },
      { $set: { owner, leaseUntil: new Date(now.getTime() + durationMs) } },
      { upsert: true, returnDocument: "after" },
    ).lean();
    return lease.owner === owner ? owner : null;
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }
}

export async function releaseProviderLease(key, owner) {
  if (typeof owner === "string" && providerStateAvailable()) {
    await ProviderLease.deleteOne({ _id: key, owner });
  }
}

export async function waitForProviderState(key, timeoutMs = 22_000, intervalMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await readProviderState(key);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
