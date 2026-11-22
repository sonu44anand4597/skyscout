import mongoose from "mongoose";

const priceObservationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  trackedFlightId: { type: mongoose.Schema.Types.ObjectId, ref: "TrackedFlight", required: true, index: true },
  price: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, uppercase: true },
  observedAt: { type: Date, default: Date.now, index: true },
  source: { type: String, default: "serpapi_google_flights" },
  quoteKey: { type: String, unique: true, sparse: true },
}, { timestamps: true });

priceObservationSchema.index({ trackedFlightId: 1, observedAt: -1 });

export default mongoose.model("PriceObservation", priceObservationSchema);
