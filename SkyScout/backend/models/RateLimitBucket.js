import mongoose from "mongoose";

const rateLimitBucketSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { versionKey: false });

export default mongoose.model("RateLimitBucket", rateLimitBucketSchema);
