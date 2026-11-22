// Dry run by default. Only fills missing timestamps when the existing current
// price exactly matches the latest real observation. No prices/history deleted.
import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/database.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';

const apply = process.argv.includes('--apply');
await connectDB();
if (mongoose.connection.readyState !== 1) throw new Error('MongoDB must be reachable.');
const result = { mode: apply ? 'apply' : 'dry_run', inspected: 0, eligible: 0, updated: 0, needsReview: 0 };
try {
  for await (const flight of TrackedFlight.find({ quoteObservedAt: null }).cursor()) {
    result.inspected++;
    const observation = await PriceObservation.findOne({ userId: flight.userId, trackedFlightId: flight._id, currency: flight.currency }).sort({ observedAt: -1 }).lean();
    if (!observation || observation.price !== flight.currentPrice) { result.needsReview++; continue; }
    result.eligible++;
    if (apply) { const update = await TrackedFlight.updateOne({ _id: flight._id, quoteObservedAt: null, currentPrice: observation.price }, { $set: { quoteObservedAt: observation.observedAt } }); result.updated += update.modifiedCount; }
  }
  console.log(JSON.stringify(result));
} finally { await mongoose.disconnect(); }
