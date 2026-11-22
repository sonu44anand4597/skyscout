import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins, validateRuntime } from './runtime.js';
test('production refuses missing storage, insecure origins and invalid cookie/proxy settings', () => {
  assert.deepEqual(allowedOrigins({}), ['http://localhost:5173', 'http://127.0.0.1:5173']);
  assert.throws(() => validateRuntime({ NODE_ENV: 'production' }), /MONGODB_URI/);
  assert.throws(() => validateRuntime({ NODE_ENV: 'production', MONGODB_URI: 'fixture' }), /CLIENT_ORIGINS/);
  assert.throws(() => validateRuntime({ NODE_ENV: 'production', MONGODB_URI: 'fixture', CLIENT_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.throws(() => allowedOrigins({ CLIENT_ORIGIN: 'https://example.com/path' }), /origins/);
  assert.throws(() => validateRuntime({ SESSION_SAME_SITE: 'invalid' }), /SESSION_SAME_SITE/);
  assert.throws(() => validateRuntime({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.throws(() => validateRuntime({ NODE_ENV: 'production', MONGODB_URI: 'fixture', CLIENT_ORIGINS: ', , ' }), /CLIENT_ORIGINS/);
  for (const PORT of ['0', '65536', 'server-pipe', '-1']) assert.throws(() => validateRuntime({ PORT }), /PORT/);
  assert.deepEqual(validateRuntime({ NODE_ENV: 'production', MONGODB_URI: 'fixture', CLIENT_ORIGINS: 'https://one.example,https://two.example', SESSION_SAME_SITE: 'None', TRUST_PROXY: '1' }).origins, ['https://one.example', 'https://two.example']);
});
