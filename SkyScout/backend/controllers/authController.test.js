import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import AuthSession from '../models/AuthSession.js';
import { logout } from './authController.js';

test('logout revokes the presented token after expiry and clears missing or malformed cookies safely', async () => {
  const original = AuthSession.deleteOne;
  const revoked = [];
  AuthSession.deleteOne = async (filter) => { revoked.push(filter); };
  try {
    const token = 'a'.repeat(43);
    for (const cookie of [`skyscout_session=${token}`, '', 'skyscout_session=%invalid']) {
      let cleared;
      let payload;
      await logout({ headers: { cookie } }, { setHeader: (_name, value) => { cleared = value; }, json: (value) => { payload = value; } }, (error) => { throw error; });
      assert.match(cleared, /Max-Age=0/);
      assert.match(cleared, /HttpOnly/);
      assert.equal(payload.success, true);
    }
    assert.deepEqual(revoked, [{ tokenHash: createHash('sha256').update(token).digest('hex') }]);
  } finally { AuthSession.deleteOne = original; }
});
