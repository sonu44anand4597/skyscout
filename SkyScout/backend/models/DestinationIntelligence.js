import mongoose from "mongoose";

const sourceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true },
  publishedAt: { type: Date, required: true },
  retrievedAt: { type: Date, required: true },
  tier: { type: String, enum: ["official", "news", "local"], required: true },
}, { _id: false });

const eventSchema = new mongoose.Schema({
  eventType: { type: String, required: true },
  title: String,
  headline: { type: String, required: true },
  summary: { type: String, required: true },
  affectedAreas: { type: [String], default: [] },
  affectedTransport: { type: [String], default: [] },
  travellerImpact: { type: String, required: true },
  practicalGuidance: { type: String, required: true },
  guidance: String,
  severity: { type: String, enum: ["low", "moderate", "high", "critical"], required: true },
  confidence: { type: String, enum: ["low", "medium", "high"], required: true },
  publishedAt: { type: Date, required: true },
  lastVerifiedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ["recent_report"], default: "recent_report" },
  sources: { type: [sourceSchema], default: [] },
  sourceCount: Number,
}, { _id: false });

const destinationIntelligenceSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  city: { type: String, required: true },
  country: { type: String, required: true },
  countryCode: { type: String, required: true },
  events: { type: [eventSchema], default: [] },
  searchesCompleted: Number,
  searchesAttempted: Number,
  coverage: { type: mongoose.Schema.Types.Mixed },
  diagnostics: { type: mongoose.Schema.Types.Mixed },
  checkedAt: { type: Date, required: true },
  refreshAfter: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

export default mongoose.model("DestinationIntelligence", destinationIntelligenceSchema);
