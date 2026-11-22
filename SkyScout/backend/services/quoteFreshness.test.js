import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteIsFresh } from './quoteFreshness.js';
test('freshness uses original quote time, bounded clock skew and a five-minute policy', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  assert.equal(quoteIsFresh('2026-10-29T09:55:00Z', now), true);
  assert.equal(quoteIsFresh('2026-10-29T09:54:59Z', now), false);
  assert.equal(quoteIsFresh('2026-10-29T10:10:00Z', now), false);
  assert.equal(quoteIsFresh('invalid', now), false);
});
