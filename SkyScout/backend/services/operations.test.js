import test from 'node:test';
import assert from 'node:assert/strict';
import { recordOperation } from './operations.js';

test('operation recovery preserves failure history without attributing old errors to a successful request', () => {
  const failed = recordOperation('qa-operation-recovery', 'timeout', { httpStatus: 504 });
  const recovered = recordOperation('qa-operation-recovery', 'ok', { sourceCount: 3 });
  assert.equal(recovered.lastFailureAt, failed.lastFailureAt);
  assert.ok(recovered.lastSuccessAt);
  assert.equal(recovered.successes, 1); assert.equal(recovered.failures, 1);
  assert.deepEqual(recovered.details, { sourceCount: 3 });
});
