import test from 'node:test';
import assert from 'node:assert/strict';
import { pagination, pageResults } from './pagination.js';
test('pagination bounds untrusted limits and uses a stable exclusive ID cursor', () => {
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'invalid' }]) assert.equal(pagination(query), null);
  const id = '507f1f77bcf86cd799439011';
  assert.equal(String(pagination({ cursor: id }).filter._id.$lt), id);
  assert.deepEqual(pageResults([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }], 2, 3), { data: [{ _id: 'a' }, { _id: 'b' }], pagination: { limit: 2, total: 3, nextCursor: 'b' } });
  assert.equal(pageResults([], 50, 0).pagination.nextCursor, null);
});
