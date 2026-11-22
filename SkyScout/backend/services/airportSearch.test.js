import test from 'node:test';
import assert from 'node:assert/strict';
import { airportCatalogInfo, normalizeAirport, searchAirportCatalog } from './airportCatalog.js';
import { createAirportSearch, parseAirportSuggestions } from './airportSearch.js';

test('worldwide MIT catalog resolves cities, IATA codes, names, aliases and case variants', () => {
  assert.ok(airportCatalogInfo.count > 7000);
  for (const [query, code] of [['mumbai', 'BOM'], ['Mumbai', 'BOM'], ['MUM', 'BOM'], ['BOM', 'BOM'], ['Bombay', 'BOM'], ['Chhatrapati Shivaji', 'BOM'], ['Delhi', 'DEL'], ['Indira Gandhi', 'DEL'], ['Bangalore', 'BLR'], ['Bengaluru', 'BLR'], ['Kempegowda', 'BLR'], ['Hyderabad', 'HYD'], ['Chennai', 'MAA'], ['Kolkata', 'CCU'], ['Pune', 'PNQ'], ['Dubai', 'DXB']]) {
    assert.ok(searchAirportCatalog(query).some((item) => item.iata === code), query);
  }
  const london = searchAirportCatalog('London');
  for (const code of ['LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN']) assert.ok(london.some((item) => item.iata === code), code);
  assert.equal(new Set(london.map((item) => item.iata)).size, london.length);
  assert.equal(searchAirportCatalog('not-an-airport-xyz').length, 0);
});

test('external airport responses reject malformed containers and normalize individual records', () => {
  for (const payload of [{}, { suggestions: {} }, { suggestions: [null] }, { suggestions: [{ airports: {} }] }]) assert.throws(() => parseAirportSuggestions(payload), { providerCode: 'invalid_response' });
  assert.equal(normalizeAirport({ id: 'LON', city: 'London' }), null);
  const items = parseAirportSuggestions({ suggestions: [{ name: 'Mumbai, India', airports: [{ id: 'BOM', name: 'Provider name' }, { id: '/m/123', name: 'City group' }] }] });
  assert.equal(items.length, 1); assert.equal(items[0].iata, 'BOM'); assert.ok(items[0].name.includes('Maharaj'));
});

const noStorage = { read: async () => null, store: async () => {} };
test('known airport searches use the real catalog without spending provider quota', async () => {
  const search = createAirportSearch({ ...noStorage, provider: async () => assert.fail('known airports must not spend flight-provider quota') });
  for (const [query, code] of [['Mumbai','BOM'],['Bombay','BOM'],['Delhi','DEL'],['Bangalore','BLR'],['Bengaluru','BLR'],['Hyderabad','HYD'],['Chennai','MAA'],['Dubai','DXB']]) {
    const result = await search(query); assert.equal(result.source, 'catalog'); assert.equal(result.providerStatus, 'not_requested');
    assert.ok(result.items.some(item => item.iata === code)); assert.equal(result.message, undefined);
  }
});
test('quota and invalid provider responses return real local airports with explicit degraded status', async () => {
  for (const provider of [async () => { throw Object.assign(new Error('quota fixture'), { providerCode: 'quota_exceeded' }); }, async () => ({ data: {} })]) {
    const search = createAirportSearch({ ...noStorage, provider, preferCatalog: false });
    const result = await search('mumbai'); assert.equal(result.source, 'catalog_fallback');
    assert.ok(result.items.some((item) => item.iata === 'BOM')); assert.match(result.message, /local results/);
    const empty = await search('unknown-place-xyz'); assert.equal(empty.items.length, 0); assert.match(empty.message, /having trouble/);
  }
});

test('successful empty result is distinct from outage; unrelated provider airports are filtered', async () => {
  const search = createAirportSearch({ ...noStorage, preferCatalog: false, provider: async () => ({ data: { suggestions: [{ name: 'Unrelated', airports: [{ id: 'JFK', name: 'John F Kennedy', city: 'New York' }, { id: 'BOM', name: 'Mumbai', city: 'Mumbai' }] }] } }) });
  const result = await search('mumbai'); assert.equal(result.providerStatus, 'ok');
  assert.ok(result.items.some((item) => item.iata === 'BOM')); assert.ok(!result.items.some((item) => item.iata === 'JFK'));
  const empty = await search('unknown-place-xyz'); assert.equal(empty.items.length, 0); assert.equal(empty.message, undefined);
});

test('case-normalized searches share one provider call, cache locally and retry degraded entries after expiry', async () => {
  let calls = 0; let time = 1000;
  const search = createAirportSearch({ ...noStorage, preferCatalog: false, now: () => time, provider: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); throw Object.assign(new Error('fixture'), { providerCode: 'timeout' }); } });
  const [a, b] = await Promise.all([search('Mumbai'), search('mumbai')]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal((await search('MUMBAI')).cached, true);
  time += 61000; await search('mumbai'); assert.equal(calls, 2);
  await assert.rejects(search('m'), { status: 400 }); await assert.rejects(search('a'.repeat(81)), { status: 400 });
  assert.equal(calls, 2);
});
