import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  trackedFlightId: { type: mongoose.Schema.Types.ObjectId, ref: "TrackedFlight", default: null },
  type: { type: String, enum: ["PRICE_DROP", "TARGET_REACHED", "CHECK_UNRESOLVED", "DISRUPTION_RISK_CHANGE"], required: true },
  title: { type: String, required: true, maxlength: 160 },
  message: { type: String, required: true, maxlength: 500 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  dedupeKey: { type: String, required: true, unique: true },
  read: { type: Boolean, default: false, index: true },
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, _id: -1 });
notificationSchema.index({ userId: 1, read: 1 });

export default mongoose.model("Notification", notificationSchema);
