import mongoose from "mongoose";

const providerStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: false });

export default mongoose.model("ProviderState", providerStateSchema);
