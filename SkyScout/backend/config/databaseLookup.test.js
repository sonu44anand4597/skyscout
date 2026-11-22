import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseLookup } from './databaseLookup.js';

const invoke = (lookup, opts = {}) => new Promise((resolve, reject) => lookup('replica.example', opts, (error, address, family) => error ? reject(error) : resolve({ address, family })));
test('socket DNS fallback handles all-address results and configured resolve4', async () => {
  const lookup = createDatabaseLookup({ lookup: (_host, _opts, cb) => cb(new Error('OS DNS failed')), resolve4: (_host, cb) => cb(null, ['192.0.2.1']) });
  assert.deepEqual((await invoke(lookup, { all: true })).address, [{ address: '192.0.2.1', family: 4 }]);
});
test('recent successful addresses survive transient lookup failure but expire after five minutes', async () => {
  let clock = 0; let fail = false;
  const lookup = createDatabaseLookup({ now: () => clock, lookup: (_host, _opts, cb) => fail ? cb(new Error('OS failure')) : cb(null, '192.0.2.2', 4), resolve4: (_host, cb) => cb(new Error('DNS failure')) });
  assert.equal((await invoke(lookup)).address, '192.0.2.2'); fail = true;
  assert.equal((await invoke(lookup)).address, '192.0.2.2'); clock = 300001;
  await assert.rejects(invoke(lookup), /OS failure/);
});
test('IPv6-only lookup never silently substitutes IPv4', async () => {
  const lookup = createDatabaseLookup({ lookup: (_host, _opts, cb) => cb(new Error('IPv6 failed')), resolve4: () => { throw new Error('Must not run'); } });
  await assert.rejects(invoke(lookup, { family: 6 }), /IPv6 failed/);
});
