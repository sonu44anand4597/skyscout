import mongoose from "mongoose";

const trackedFlightSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  fingerprint: { type: String, required: true },
  origin: { type: String, required: true, uppercase: true },
  destination: { type: String, required: true, uppercase: true },
  departureDate: { type: String, required: true },
  departureAt: { type: String, default: null },
  returnDate: { type: String, default: null },
  tripType: { type: String, enum: ["one-way", "round-trip", "multi-city"], default: "one-way" },
  roundTripLegs: { type: [mongoose.Schema.Types.Mixed], default: [] },
  journeyLegs: { type: [mongoose.Schema.Types.Mixed], default: [] },
  airline: { type: String, default: null },
  flightNumber: { type: String, default: null },
  segments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  adults: { type: Number, default: 1, min: 1, max: 9 },
  children: { type: Number, default: 0, min: 0, max: 8 },
  infants: { type: Number, default: 0, min: 0, max: 9 },
  travelClass: { type: Number, default: 1, min: 1, max: 4 },
  initialPrice: { type: Number, required: true, min: 1 },
  currentPrice: { type: Number, required: true, min: 1 },
  quoteObservedAt: { type: Date, default: null },
  currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
  targetPrice: { type: Number, default: null, min: 1 },
  status: { type: String, enum: ["active", "paused", "completed", "unresolved"], default: "active", index: true },
  lastCheckedAt: { type: Date, default: null },
  nextCheckAt: { type: Date, default: Date.now, index: true },
  checkLeaseUntil: { type: Date, default: null },
  checkLeaseOwner: { type: String, default: null },
  lastCheckError: { type: String, default: null },
  checkFailures: { type: Number, default: 0 },
}, { timestamps: true });

trackedFlightSchema.index({ userId: 1, fingerprint: 1 }, { unique: true });
trackedFlightSchema.index({ userId: 1, _id: -1 });
trackedFlightSchema.index({ userId: 1, status: 1 });
trackedFlightSchema.index({ status: 1, nextCheckAt: 1 });

export default mongoose.model("TrackedFlight", trackedFlightSchema);
