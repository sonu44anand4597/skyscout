import mongoose from "mongoose";

const providerLeaseSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  owner: { type: String, required: true },
  leaseUntil: { type: Date, required: true, index: { expires: 0 } },
}, { versionKey: false });

export default mongoose.model("ProviderLease", providerLeaseSchema);
