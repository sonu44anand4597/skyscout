import mongoose from "mongoose";

const disruptionPredictionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  trackedFlightId: { type: mongoose.Schema.Types.ObjectId, ref: "TrackedFlight", required: true, index: true },
  modelVersion: { type: String, required: true },
  probability: { type: Number, required: true, min: 0, max: 1 },
  riskLevel: { type: String, enum: ["low", "medium", "high"], required: true },
  generatedAt: { type: Date, default: Date.now },
  inputSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

disruptionPredictionSchema.index({ trackedFlightId: 1, generatedAt: -1 });

export default mongoose.model("DisruptionPrediction", disruptionPredictionSchema);
