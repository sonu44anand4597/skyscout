import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  trackedFlightId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  itinerary: mongoose.Schema.Types.Mixed,
  report: mongoose.Schema.Types.Mixed,
  checkedAt: Date,
  expiresAt: Date,
  purgeAt: { type: Date, index: { expires: 0 } },
  lastAttempt: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
export default mongoose.model('IntelligenceReport', schema);
