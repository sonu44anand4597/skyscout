import Notification from "../models/Notification.js";
import mongoose from 'mongoose';
import TrackedFlight from '../models/TrackedFlight.js';

export class InAppNotificationProvider {
  async send({ userId, trackedFlightId, type, title, message, dedupeKey, metadata = {} }) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (trackedFlightId) {
          // Conflict with a concurrent cascade delete, preventing orphan alerts.
          const owner = await TrackedFlight.updateOne({ _id: trackedFlightId, userId }, { $set: { updatedAt: new Date() } }, { session });
          if (!owner.matchedCount) return;
        }
        await Notification.updateOne({ dedupeKey }, { $setOnInsert: { userId, trackedFlightId, type, title, message, dedupeKey, metadata } }, { upsert: true, session });
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
    } finally { await session.endSession(); }
  }
}

export async function dispatchNotification(notification, providers, onDeliveryError = () => {}) {
  for (const entry of providers) {
    const provider = entry?.provider || entry;
    const required = entry?.provider ? entry.required !== false : true;
    if (typeof provider?.send !== "function") throw new TypeError("Notification providers must implement send().");
    try {
      await provider.send(notification);
    } catch (error) {
      if (required) throw error;
      onDeliveryError(error, provider);
    }
  }
}
