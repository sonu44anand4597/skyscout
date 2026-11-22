import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const origin = 'https://skyscout-free-demo.onrender.com';
process.env.NODE_ENV = 'production';
process.env.SERVE_WEB = 'true';
process.env.RENDER_EXTERNAL_URL = origin;
process.env.MONGODB_URI = 'mongodb://render-blueprint-validation.invalid/skyscout';
process.env.SERPAPI_API_KEY = '';
process.env.TRUST_PROXY = '1';
process.env.SESSION_SAME_SITE = 'Lax';
delete process.env.CLIENT_ORIGINS;
delete process.env.CLIENT_ORIGIN;

const { validateRuntime } = await import('../config/runtime.js');
const { createApp } = await import('../app.js');
const origins = validateRuntime().origins;
assert.deepEqual(origins, [origin], 'Render external URL must supply the same-origin production CORS allowlist');

const assetsPath = fileURLToPath(new URL('../../dist/assets/', import.meta.url));
const server = createApp({ databaseHealth: () => ({ state: 'disconnected', retryInSeconds: null }) }).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<div id="root"><\/div>/);
  assert.match(home.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(home.headers.get('cache-control') || '', /no-cache/);

  const dashboard = await fetch(`${base}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<div id="root"><\/div>/);

  const assetName = (await readdir(assetsPath)).find((name) => name.endsWith('.js'));
  assert.ok(assetName, 'production JavaScript asset must exist');
  const asset = await fetch(`${base}/assets/${assetName}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') || '', /immutable/);

  const api = await fetch(`${base}/api/flights/airports?q=mumbai`, { headers: { Origin: origin } });
  assert.equal(api.status, 200);
  assert.equal(api.headers.get('access-control-allow-origin'), origin);
  assert.equal((await api.json()).data.some((airport) => airport.iata === 'BOM'), true);

  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  console.log('Render runtime smoke passed: same-origin SPA, dashboard deep link, immutable assets, CORS/API, and API 404 handling.');
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
