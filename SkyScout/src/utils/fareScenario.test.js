import test from 'node:test';
import assert from 'node:assert/strict';
import { daysBeforeDeparture, formatFare, formatSignedFare, formatSignedPercent } from './fareScenario.js';

test('formatters preserve fractional rupees and server percentage precision', () => {
  assert.equal(formatFare(5200.5, 'INR'), '₹5,200.5');
  assert.equal(formatSignedFare(-72, 'INR'), '−₹72');
  assert.equal(formatSignedFare(147, 'INR'), '+₹147');
  assert.equal(formatSignedPercent(-1.41), '−1.41%');
  assert.equal(formatSignedPercent(2.8), '+2.8%');
  assert.equal(formatFare(null), 'Unavailable');
  assert.equal(formatSignedPercent(undefined), 'Unavailable');
});
test('date lead-time display stops before departure without a separate browser fare engine', () => {
  assert.equal(daysBeforeDeparture('2026-10-28', '2026-10-29'), 0);
  assert.equal(daysBeforeDeparture('2026-10-28', '2026-11-01'), 3);
  assert.equal(daysBeforeDeparture('2026-10-28', '2026-10-20'), 0);
});
