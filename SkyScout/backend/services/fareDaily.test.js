import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFareBaseline } from './fareBaseline.js';
import { buildDailyFare, backtestFare, ASSUMPTIONS } from './fareDaily.js';

const flight = { origin: 'DEL', destination: 'BLR', tripType: 'one-way', currency: 'INR', departureDate: '2026-12-20' };
const now = new Date('2026-11-01T10:00:00Z');
const quote = (observedAt, price) => ({ observedAt, price, currency: 'INR' });
const sparse = buildFareBaseline(flight, [quote(now, 6000)], now);

test('assumption explorer calculates all eligible days 0–14 with exact reproducible amounts', () => {
  for (const market of Object.keys(ASSUMPTIONS)) {
    const result = buildDailyFare(sparse, { mode: 'assumption', market });
    assert.equal(result.points.length, 15);
    for (const day of [1, 2, 3, 4, 7, 14]) {
      const item = result.points[day];
      assert.equal(item.central, Math.round(6000 * Math.exp(Math.log1p(ASSUMPTIONS[market].central) * day)));
      assert.equal(item.change, item.central - 6000);
      assert.equal(item.changePercent, Number(((item.central / 6000 - 1) * 100).toFixed(2)));
      assert.equal(item.calculation.output, item.central);
      assert.equal(item.eventAdjustment, 0);
      assert.match(item.evidence, /assumption-based/);
      assert.equal(item.calculation.coefficientProvenance.classification, 'hypothetical_scenario_assumption');
      assert.equal(item.calculation.combinedPercentage, item.changePercent);
      assert.equal(item.modelType, 'conditional_hypothetical_scenario');
    }
  }
});

test('tomorrow has Day 0 only and missing fare never creates chart points', () => {
  assert.deepEqual(buildDailyFare({ ...sparse, daysUntilDeparture: 1 }, { mode: 'assumption' }).points.map((item) => item.day), [0]);
  assert.deepEqual(buildDailyFare({ ...sparse, currentFare: null }, { mode: 'assumption' }).points, []);
  assert.deepEqual(buildDailyFare({ ...sparse, daysUntilDeparture: 0 }, { mode: 'assumption' }).points, []);
});

test('qualitative events attach to dates without altering a single numerical result', () => {
  const without = buildDailyFare(sparse, { mode: 'assumption' });
  const withEvent = buildDailyFare(sparse, { mode: 'assumption', events: [{ id: 'fuel', title: 'Fuel', eventStart: '2026-11-05', impactDirection: 'upward' }] });
  assert.equal(withEvent.points[4].central, without.points[4].central);
  assert.deepEqual(withEvent.points[4].eventIds, ['fuel']);
  assert.deepEqual(withEvent.points[3].eventIds, []);
});

test('observed daily estimates require genuinely separate booking days and history span', () => {
  assert.equal(buildDailyFare(sparse).points.length, 1);
  const observations = Array.from({ length: 31 }, (_, day) => quote(new Date(Date.UTC(2026, 9, day + 1, 10)), 5000 + day * 20));
  const baseline = buildFareBaseline(flight, observations, now);
  assert.equal(buildDailyFare(baseline).points.length, 15);
  assert.equal(buildDailyFare(baseline).points[14].central, baseline.outlook.find((item) => item.daysAhead === 14).central.fare);
  const evaluation = backtestFare(flight, observations);
  assert.ok(evaluation.sampleCount > 0);
  assert.ok(evaluation.mae >= 0);
  const changedFuture = [...observations, quote('2026-11-02T10:00:00Z', 999999)];
  assert.deepEqual(backtestFare(flight, changedFuture).evaluations.slice(0, -1), evaluation.evaluations.slice(-9));
});

test('invalid observation dates cannot crash chronological fare evaluation', () => {
  assert.doesNotThrow(() => backtestFare(flight, [quote('invalid', 6000), quote('2026-10-29T10:00:00Z', 5900)]));
  assert.equal(backtestFare(flight, [quote('invalid', 6000)]).sampleCount, 0);
});
