import assert from "node:assert/strict";
import test from "node:test";
import { getDelayPrediction, isMeaningfulRiskTransition, isValidPredictionResponse, matchesPredictionInput } from "./predictionService.js";

const leg = {
  origin: "JFK",
  destination: "LAX",
  flightNumber: "AA 100",
  departureAt: "2026-11-20T09:00:00-05:00",
  durationMinutes: 360,
  stops: 0,
};

test("reuses prediction only when every inference input is unchanged", () => {
  assert.equal(matchesPredictionInput({ ...leg }, leg), true);
  for (const field of Object.keys(leg)) {
    assert.equal(matchesPredictionInput({ ...leg, [field]: `${leg[field]}-changed` }, leg), false, `changed ${field}`);
  }
});

test("does not reuse a cache entry without its saved input snapshot", () => {
  assert.equal(matchesPredictionInput(null, leg), false);
});

test("risk alerts require a band change from the same model version", () => {
  const previous = { modelVersion: "v1", riskLevel: "low" };
  assert.equal(isMeaningfulRiskTransition(previous, { modelVersion: "v1", riskLevel: "medium" }), true);
  assert.equal(isMeaningfulRiskTransition(previous, { modelVersion: "v1", riskLevel: "low" }), false);
  assert.equal(isMeaningfulRiskTransition(previous, { modelVersion: "v2", riskLevel: "medium" }), false);
  assert.equal(isMeaningfulRiskTransition(null, { modelVersion: "v1", riskLevel: "medium" }), false);
});

test("a newly served model replaces a still-fresh prediction from an older version", async () => {
  const calls = [];
  const flight = { _id: "flight-id", userId: "user-id", ...leg, segments: [{ durationMinutes: 360 }] };
  const recent = { _id: "old-prediction", modelVersion: "delay-lstm-v1", riskLevel: "low", generatedAt: new Date(), inputSummary: { flightLeg: leg } };
  const result = await getDelayPrediction(flight, {
    findRecent: async () => recent,
    getModelVersion: async () => "delay-lstm-v2",
    requestPrediction: async () => ({ data: { modelVersion: "delay-lstm-v2", probability: 0.4, riskLevel: "medium", generatedAt: new Date().toISOString() } }),
    savePrediction: async (prediction) => { calls.push("save"); return prediction; },
    notify: async () => { calls.push("notify"); },
  });
  assert.equal(result.prediction.modelVersion, "delay-lstm-v2");
  assert.deepEqual(calls, ["save"]);
});

test('ML responses require finite probabilities, valid dates and consistent regional risk bands', () => {
  const valid = { modelVersion: 'delay-lstm-v2', probability: 0.4, riskLevel: 'medium', modelRegion: 'US', generatedAt: new Date().toISOString(), riskThresholds: { medium: 0.2, high: 0.5 } };
  assert.equal(isValidPredictionResponse(valid, 'US'), true);
  for (const change of [
    { probability: NaN }, { probability: Infinity }, { probability: -0.1 }, { probability: 1.1 },
    { riskLevel: 'high' }, { riskLevel: 'unknown' }, { generatedAt: 'invalid' },
    { modelRegion: 'IN' }, { modelVersion: '' }, { riskThresholds: { medium: 0.7, high: 0.5 } },
  ]) assert.equal(isValidPredictionResponse({ ...valid, ...change }, 'US'), false, JSON.stringify(change));
});

test('invalid ML output is unavailable without saving predictions or sending notifications', async () => {
  const calls = [];
  const result = await getDelayPrediction({ _id: 'flight-id', userId: 'user-id', ...leg, segments: [{ durationMinutes: 360 }] }, {
    findRecent: async () => null,
    requestPrediction: async () => ({ data: { probability: '0.4', riskLevel: 'medium' } }),
    savePrediction: async () => { calls.push('save'); },
    notify: async () => { calls.push('notify'); },
  });
  assert.equal(result.available, false);
  assert.match(result.message, /invalid/);
  assert.deepEqual(calls, []);
});

test('an ML timeout leaves the application with an explicit unavailable prediction', async () => {
  const result = await getDelayPrediction({ _id: 'flight-id', userId: 'user-id', ...leg, segments: [{ durationMinutes: 360 }] }, {
    findRecent: async () => null,
    requestPrediction: async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); },
  });
  assert.equal(result.available, false);
  assert.match(result.message, /unavailable/);
});
