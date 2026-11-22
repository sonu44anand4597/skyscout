import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rateLimit.js';

test('authenticated research budgets do not collide for different users sharing an IP', async () => {
  const limiter = createRateLimiter({ limit: 1, keyBy: 'user' });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json() {} };
  let passed = 0;
  await limiter({ userId: 'alice', ip: 'shared' }, response, () => passed++);
  await limiter({ userId: 'bob', ip: 'shared' }, response, () => passed++);
  await limiter({ userId: 'alice', ip: 'shared' }, response, () => passed++);
  assert.equal(passed, 2);
  assert.equal(response.code, 429);
  assert.ok(Number(response.headers['Retry-After']) > 0);
});
