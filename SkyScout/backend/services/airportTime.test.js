import test from 'node:test';
import assert from 'node:assert/strict';
import { airportDate, scheduleInstant } from './airportTime.js';
import { resolveDestination } from './destinationResolver.js';
test('airport dates and flight wall times use actual IANA zones independent of the host', () => {
  assert.equal(resolveDestination('JFK').timezone, 'America/New_York');
  assert.equal(airportDate(new Date('2026-10-28T01:00:00Z'), 'America/New_York'), '2026-10-27');
  assert.equal(scheduleInstant('2026-10-28 09:00', 'Asia/Kolkata').toISOString(), '2026-10-28T03:30:00.000Z');
  assert.equal(scheduleInstant('2026-10-28 09:00', 'America/New_York').toISOString(), '2026-10-28T13:00:00.000Z');
  assert.equal(scheduleInstant('2026-10-28T09:00:00-04:00', null).toISOString(), '2026-10-28T13:00:00.000Z');
});
test('ambiguous DST, nonexistent wall times and invalid dates are never guessed', () => {
  assert.equal(scheduleInstant('2026-11-01 01:30', 'America/New_York'), null);
  assert.equal(scheduleInstant('2026-03-08 02:30', 'America/New_York'), null);
  assert.equal(scheduleInstant('2026-02-31 09:00', 'Asia/Kolkata'), null);
  assert.equal(scheduleInstant('2026-10-28 09:00', null), null);
});
