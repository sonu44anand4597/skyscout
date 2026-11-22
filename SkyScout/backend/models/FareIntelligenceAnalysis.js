import mongoose from "mongoose";

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  trackedFlightId: { type: mongoose.Schema.Types.ObjectId, ref: "TrackedFlight", required: true, index: true },
  engineVersion: { type: String, required: true },
  currency: { type: String, required: true },
  observedFare: { type: Number, required: true },
  observedAt: { type: Date, required: true },
  bookingDate: { type: String, required: true },
  baseline: { type: mongoose.Schema.Types.Mixed, required: true },
  researchLastStatus: { type: String, default: "not_checked" },
  researchCheckedAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ userId: 1, trackedFlightId: 1, createdAt: -1 });

export default mongoose.model("FareIntelligenceAnalysis", schema);
