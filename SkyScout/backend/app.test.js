import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';

let server;
let base;
before(async () => {
  server = createApp({ origins: ['https://skyscout.example'], databaseHealth: () => ({ state: 'disconnected' }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
test('CSRF rejects form posts and foreign origins, including login', async () => {
  for (const headers of [{ 'Content-Type': 'application/json' }, { 'X-SkyScout-Request': '1', Origin: 'https://foreign.example' }]) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CSRF_REJECTED');
  }
});
test('trusted browser mutations reach validation with credentialed CORS', async () => {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'X-SkyScout-Request': '1', Origin: 'https://skyscout.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://skyscout.example');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});
test('invalid JSON and oversized bodies have safe distinct errors and correlation IDs', async () => {
  for (const [body, status] of [['{broken', 400], [JSON.stringify({ input: 'a'.repeat(34000) }), 413]]) {
    const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'X-SkyScout-Request': '1', 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status);
    assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(await response.json()).includes('SyntaxError'), false);
  }
});
test('liveness remains available while readiness fails and operations stay private', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  assert.equal((await fetch(`${base}/api/operations`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/tracked-flights`)).status, 401);
});

test('logout is idempotent without a session while retaining browser CSRF protection', async () => {
  const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'X-SkyScout-Request': '1' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status, 403);
});

test('airport HTTP endpoint remains usable without provider credentials and reports genuine catalog provenance', async () => {
  const previous = process.env.SERPAPI_API_KEY; process.env.SERPAPI_API_KEY = '';
  try {
    const response = await fetch(`${base}/api/flights/airports?q=mumbai`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true); assert.ok(result.data.some((item) => item.iata === 'BOM'));
    assert.equal(result.airportSearch.source, 'catalog'); assert.equal(result.airportSearch.providerStatus, 'not_requested'); assert.equal(result.airportSearch.message, undefined);
    assert.equal((await fetch(`${base}/api/flights/airports?q=m`)).status, 400);
  } finally { if (previous === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = previous; }
});
