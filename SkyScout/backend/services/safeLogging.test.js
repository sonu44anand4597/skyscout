import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceErrorDetails } from './safeLogging.js';

test('operational errors keep useful classifications without serializing credentials, URLs or provider bodies', () => {
  const secret = 'fixtureCredentialNeverLog';
  const error = Object.assign(new Error(`https://provider.test/?api_key=${secret}`), {
    name: 'AxiosError', code: 'ECONNABORTED', providerCode: 'timeout',
    config: { params: { api_key: secret } }, response: { status: 504, data: { error: secret } },
  });
  assert.deepEqual(serviceErrorDetails('provider_failed', error), { event: 'provider_failed', category: 'AxiosError', code: 'ECONNABORTED', providerCode: 'timeout', httpStatus: 504 });
  assert.doesNotMatch(JSON.stringify(serviceErrorDetails('provider_failed', error)), new RegExp(secret));
  assert.deepEqual(serviceErrorDetails('provider_failed', { name: secret, code: secret, providerCode: secret }), { event: 'provider_failed', category: 'service_error' });
});
