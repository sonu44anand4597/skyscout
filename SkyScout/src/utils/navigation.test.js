import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardPath, internalReturnPath, readDashboardSelection, saveDashboardSelection } from './navigation.js';
import { createResultsCache, resultsViewKey } from './resultsCache.js';

test('login return paths keep dashboard query context and reject external redirects', () => {
  assert.equal(internalReturnPath('/dashboard?flight=abc#details'), '/dashboard?flight=abc#details');
  for (const value of ['https://attacker.test', '//attacker.test', '/\\attacker.test', '\\attacker.test', 'javascript:alert(1)', '/\n/attacker.test', null]) assert.equal(internalReturnPath(value), '/dashboard');
  assert.equal(dashboardPath('a'.repeat(24)), `/dashboard?flight=${'a'.repeat(24)}`);
  assert.equal(dashboardPath('not-an-id'), '/dashboard');
});

test('dashboard selection is scoped per user and storage failures remain nonfatal', () => {
  const map = new Map(); const storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
  saveDashboardSelection('A', 'a'.repeat(24), storage);
  assert.equal(readDashboardSelection('A', storage), 'a'.repeat(24)); assert.equal(readDashboardSelection('B', storage), '');
  assert.equal(readDashboardSelection('A', { getItem: () => { throw new Error('disabled'); } }), '');
  assert.doesNotThrow(() => saveDashboardSelection('A', 'a'.repeat(24), { setItem: () => { throw new Error('disabled'); } }));
});

test('Back navigation snapshots preserve filters and continuation, expire and stay bounded per user/history', () => {
  let time = 1000; const cache = createResultsCache({ now: () => time, limit: 2, ttlMs: 5000 });
  const a = resultsViewKey('A', 'results-1', { origin: 'BOM', destination: 'DEL' });
  const b = resultsViewKey('B', 'results-1', { origin: 'BOM', destination: 'DEL' });
  const view = { allFlights: [{ id: 'offer' }], selectedSort: 'Fastest', searchStage: 'return', trackedFlightIds: { offer: 'a'.repeat(24) } };
  cache.write(a, view); assert.deepEqual(cache.read(a), view); assert.equal(cache.read(b), null);
  time += 3000; cache.write(a, { ...view, selectedSort: 'Cheapest' });
  time += 2000; assert.equal(cache.read(a), null, 'filter edits do not extend a quote navigation cache indefinitely');
  cache.write(a, view); cache.write(b, {}); cache.write('third', {}); assert.equal(cache.read(a), null);
  cache.clear(); assert.equal(cache.read('third'), null);
});

test('removing tracking clears only its cached association, retaining offers and filters', () => {
  const cache = createResultsCache();
  cache.write('view', { allFlights: ['offer'], selectedSort: 'Fastest', trackedFlightIds: { offer: 'A', other: 'B' }, lastTrackedFlightId: 'A' });
  cache.untrack('A');
  assert.deepEqual(cache.read('view'), { allFlights: ['offer'], selectedSort: 'Fastest', trackedFlightIds: { other: 'B' }, lastTrackedFlightId: null });
});
