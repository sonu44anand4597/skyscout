import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastValidity } from './weatherFreshness.js';

test('TAF validity labels expired, active, upcoming and unknown periods independently of fetch time', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  assert.equal(forecastValidity({ validFrom: '2026-11-02T10:00:00Z', validTo: '2026-11-03T10:00:00Z' }, now), 'expired');
  assert.equal(forecastValidity({ validFrom: '2026-11-03T09:00:00Z', validTo: '2026-11-04T10:00:00Z' }, now), 'active');
  assert.equal(forecastValidity({ validFrom: '2026-11-03T11:00:00Z', validTo: '2026-11-04T10:00:00Z' }, now), 'upcoming');
  assert.equal(forecastValidity({ validFrom: 'invalid' }, now), 'unknown');
});
