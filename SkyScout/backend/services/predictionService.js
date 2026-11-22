import axios from "axios";
import DisruptionPrediction from "../models/DisruptionPrediction.js";
import { createNotification } from "./notificationService.js";
import { normalizeIndianAirline, predictionRegion } from "./predictionRegion.js";
import { getIndianOperationalContext } from "./indiaOperationalContext.js";

const mlUrl = () => process.env.ML_SERVICE_URL || "http://127.0.0.1:8001";
const defaultPredictionDependencies = {
  requestPrediction: (leg) => axios.post(`${mlUrl()}/predict`, leg, { timeout: 5000 }),
  getModelVersion: async (region = "US") => {
    try {
      const response = await axios.get(`${mlUrl()}/health`, { timeout: 1500 });
      return response.data.available ? (response.data.regions?.[region] || (region === "US" ? response.data.modelVersion : null)) : null;
    } catch {
      return null;
    }
  },
  findRecent: (flight) => DisruptionPrediction.findOne({ userId: flight.userId, trackedFlightId: flight._id }).sort({ generatedAt: -1 }).lean(),
  savePrediction: (prediction) => DisruptionPrediction.create(prediction),
  notify: createNotification,
};

function predictionLeg(flight) {
  const leg = flight.tripType === "round-trip" ? flight.roundTripLegs?.[0]
    : flight.tripType === "multi-city" ? flight.journeyLegs?.[0] : null;
  const segments = leg?.segments?.length ? leg.segments : flight.segments || [];
  return {
    origin: leg?.from || flight.origin,
    destination: leg?.to || flight.destination,
    flightNumber: leg?.flightNumber || flight.flightNumber,
    airline: leg?.airline || flight.airline,
    departureAt: leg?.departureAt || leg?.departure || flight.departureAt,
    durationMinutes: leg?.durationMinutes ?? segments[0]?.durationMinutes,
    stops: Number.isInteger(leg?.stops) ? leg.stops : Math.max(segments.length - 1, 0),
  };
}

export function matchesPredictionInput(cachedLeg, currentLeg) {
  return Boolean(cachedLeg && ["origin", "destination", "flightNumber", "departureAt", "durationMinutes", "stops"]
    .every((field) => cachedLeg[field] === currentLeg[field]));
}

export function isMeaningfulRiskTransition(previous, current) {
  return Boolean(previous && current && previous.modelVersion === current.modelVersion
    && previous.riskLevel !== current.riskLevel);
}

export function isValidPredictionResponse(data, expectedRegion) {
  if (!data || typeof data.modelVersion !== 'string' || !data.modelVersion.trim() || data.modelVersion.length > 80
    || !Number.isFinite(data.probability) || data.probability < 0 || data.probability > 1
    || !['low', 'medium', 'high'].includes(data.riskLevel)
    || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))
    || (data.modelRegion && data.modelRegion !== expectedRegion)) return false;
  if (data.riskThresholds) {
    const { medium, high } = data.riskThresholds;
    if (!Number.isFinite(medium) || !Number.isFinite(high) || medium < 0 || medium >= high || high > 1) return false;
    const expectedBand = data.probability < medium ? 'low' : data.probability < high ? 'medium' : 'high';
    if (data.riskLevel !== expectedBand) return false;
  }
  return true;
}

export async function getDelayPrediction(trackedFlight, dependencies = {}) {
  const { requestPrediction, getModelVersion, findRecent, savePrediction, notify, getOperationalContext } = { ...defaultPredictionDependencies, getOperationalContext: getIndianOperationalContext, ...dependencies };
  const leg = predictionLeg(trackedFlight);
  const region = predictionRegion(leg.origin, leg.destination);
  if (region === "IN") {
    const installedVersion = await getModelVersion("IN");
    if (!installedVersion) {
      const airline = normalizeIndianAirline(trackedFlight.airline, leg.flightNumber);
      console.info("Indian delay estimate unavailable: no validated Indian flight-level LSTM artifact", { origin: leg.origin, destination: leg.destination, airline: airline || "unrecognized" });
      const operationalContext = await getOperationalContext(trackedFlight.airline, leg.flightNumber).catch(() => null);
      return { available: false, region: "IN", message: "Delay estimate currently unavailable for this flight. A validated Indian flight-level delay model has not been trained.", operationalContext };
    }
  }
  const recent = await findRecent(trackedFlight);
  const sameLeg = matchesPredictionInput(recent?.inputSummary?.flightLeg, leg);
  if (recent && sameLeg && Date.now() - new Date(recent.generatedAt).getTime() < 6 * 60 * 60 * 1000) {
    const currentVersion = await getModelVersion(region || "US");
    if (!currentVersion) return { available: false, message: "Prediction service is currently unavailable." };
    if (currentVersion === recent.modelVersion) return { available: true, prediction: recent };
  }

  try {
    const response = await requestPrediction({ ...leg });
    if (!isValidPredictionResponse(response.data, region)) return { available: false, message: 'Prediction service returned an invalid estimate.' };
    const prediction = await savePrediction({ userId: trackedFlight.userId, trackedFlightId: trackedFlight._id, modelVersion: response.data.modelVersion, probability: response.data.probability, riskLevel: response.data.riskLevel, generatedAt: response.data.generatedAt, inputSummary: { region: response.data.modelRegion || region, scope: response.data.scope, target: response.data.target, metrics: response.data.metrics, evaluation: response.data.evaluation, riskThresholds: response.data.riskThresholds, flightLeg: leg } });
    if (sameLeg && isMeaningfulRiskTransition(recent, prediction)) {
      const bands = { low: "Low", medium: "Medium", high: "High" };
      await notify({
        userId: trackedFlight.userId,
        trackedFlightId: trackedFlight._id,
        type: "DISRUPTION_RISK_CHANGE",
        title: `Disruption estimate moved to ${bands[prediction.riskLevel] || prediction.riskLevel} risk`,
        message: `The estimated delay risk for ${leg.origin} to ${leg.destination} changed from ${bands[recent.riskLevel] || recent.riskLevel} to ${bands[prediction.riskLevel] || prediction.riskLevel}.`,
        dedupeKey: `risk:${trackedFlight._id}:${recent._id}:${prediction.riskLevel}`,
        metadata: { previousRiskLevel: recent.riskLevel, riskLevel: prediction.riskLevel, previousProbability: recent.probability, probability: prediction.probability, modelVersion: prediction.modelVersion },
      });
    }
    return { available: true, prediction };
  } catch (error) {
    if (error.response?.status >= 500 || error.code === "ECONNREFUSED" || error.code === "ECONNABORTED") return { available: false, message: "Prediction is currently unavailable." };
    const detail = error.response?.data?.detail;
    return { available: false, message: typeof detail === "string" ? detail : "Prediction is not supported for this flight." };
  }
}
