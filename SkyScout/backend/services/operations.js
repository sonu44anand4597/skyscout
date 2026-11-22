import { timingSafeEqual } from 'node:crypto';
import { providerStateAvailable, readProviderState } from './providerState.js';
import ProviderState from '../models/ProviderState.js';

const statuses = new Map();
export function recordOperation(name, status, details = {}) {
  const previous = statuses.get(name) || { successes: 0, failures: 0 };
  const at = new Date().toISOString();
  const value = { status, checkedAt: at, details,
    successes: previous.successes + (status === 'ok' ? 1 : 0),
    failures: previous.failures + (status === 'ok' ? 0 : 1),
    ...(previous.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
    ...(previous.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
    ...(status === 'ok' ? { lastSuccessAt: at } : { lastFailureAt: at }),
  };
  statuses.set(name, value);
  return value;
}
export async function persistOperation(name, status, details = {}) {
  const value = recordOperation(name, status, details);
  if (providerStateAvailable()) {
    await ProviderState.updateOne({ key: `operations:${name}` }, {
      $set: { 'payload.status': status, 'payload.checkedAt': value.checkedAt, 'payload.details': details, expiresAt: new Date(Date.now() + 7 * 86400000) },
      $inc: { 'payload.successes': status === 'ok' ? 1 : 0, 'payload.failures': status === 'ok' ? 0 : 1 },
      $max: { [status === 'ok' ? 'payload.lastSuccessAt' : 'payload.lastFailureAt']: value.checkedAt },
    }, { upsert: true });
  }
  return value;
}
export async function operationSnapshot() {
  const result = Object.fromEntries(statuses);
  const names = ['serpapi', 'gemini', 'monitoring', 'rate_limit'];
  const saved = await Promise.all(names.map((name) => readProviderState(`operations:${name}`)));
  names.forEach((name, index) => {
    const value = saved[index] || result[name];
    result[name] = value ? Object.fromEntries(['status', 'checkedAt', 'details', 'successes', 'failures', 'lastSuccessAt', 'lastFailureAt'].filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) : { status: 'not_observed' };
  });
  return result;
}
export function requireOperationsToken(req, res, next) {
  const expected = process.env.OPERATIONS_TOKEN;
  const supplied = req.get('authorization')?.replace(/^Bearer /, '') || '';
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected || '');
  if (!expected || suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return res.status(404).json({ success: false, message: 'Not found.' });
  }
  return next();
}
