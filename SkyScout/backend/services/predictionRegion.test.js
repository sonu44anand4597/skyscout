import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIndianAirline, predictionRegion } from "./predictionRegion.js";
import { getDelayPrediction } from "./predictionService.js";
import { parseOfficialOtp } from "./indiaOperationalContext.js";

test("routes Indian and US domestic flights by resolved airport country", () => {
  assert.equal(predictionRegion("DEL", "BOM"), "IN");
  assert.equal(predictionRegion("HYD", "CCU"), "IN");
  assert.equal(predictionRegion("JFK", "LAX"), "US");
  assert.equal(predictionRegion("DEL", "JFK"), null);
});

test("normalizes known Indian carrier codes and names without guessing unknown carriers", () => {
  assert.equal(normalizeIndianAirline("IndiGo", "6E 123"), "6E");
  assert.equal(normalizeIndianAirline("Air India Express", "unknown"), "IX");
  assert.equal(normalizeIndianAirline("Other Airline", "ZZ 123"), null);
});

test("Indian flight without a validated artifact never receives a probability", async () => {
  const result = await getDelayPrediction({ origin: "DEL", destination: "BOM", airline: "IndiGo", flightNumber: "6E 123" }, {
    findRecent: async () => { throw new Error("Indian guard should run before cache lookup"); },
    requestPrediction: async () => { throw new Error("Indian guard should run before US inference"); },
    getModelVersion: async () => null,
    getOperationalContext: async () => ({ otpPercent: 91, usedInPrediction: false }),
  });
  assert.equal(result.available, false);
  assert.equal(result.region, "IN");
  assert.equal(result.prediction, undefined);
  assert.equal(result.operationalContext.usedInPrediction, false);
});

test("official aggregate OTP parser keeps airline percentages separate from flight records", () => {
  const html = 'Date <div class="field__item">On 06 October 2026</div><div class="field--name-field-label">IndiGo</div><div class="field--name-field-counting-number">91.00%</div>';
  const parsed = parseOfficialOtp(html);
  assert.equal(parsed.airlines["6E"], 91);
  assert.equal(parsed.reportedDate, "06 October 2026");
  assert.equal(parsed.granularity, "airline-level aggregate on-time performance");
});
