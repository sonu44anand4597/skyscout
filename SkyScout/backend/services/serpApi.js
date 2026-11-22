import axios from 'axios';
import { createHash } from 'node:crypto';
import RateLimitBucket from '../models/RateLimitBucket.js';
import { claimProviderLease, providerStateAvailable, readProviderState, releaseProviderLease, storeProviderState } from './providerState.js';
import { persistOperation } from './operations.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let active = 0;
const proxyConfigured = () => ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  .some((name) => Boolean(process.env[name]));

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (value == null || value === '') return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now) || 0;
}
export function providerError(cause) {
  if (cause.providerCode) return cause;
  const httpStatus = Number(cause.response?.status) || null;
  const text = String(cause.response?.data?.error || '');
  const exhausted = /quota|credit|run out|searches.*(?:exceed|left)|monthly|hourly/i.test(text);
  const providerCode = httpStatus === 401 || httpStatus === 403 ? 'invalid_key'
    : httpStatus === 429 ? exhausted ? 'quota_exceeded' : 'rate_limited'
      : cause.code === 'ECONNABORTED' || cause.code === 'ETIMEDOUT' ? 'timeout'
        : httpStatus && httpStatus < 500 ? 'invalid_query' : 'provider_unavailable';
  const error = new Error(`SerpApi request failed (${providerCode}${httpStatus ? `, HTTP ${httpStatus}` : ''}).`);
  Object.assign(error, { providerCode, providerStatus: httpStatus, status: ['invalid_key', 'quota_exceeded', 'rate_limited'].includes(providerCode) ? 503 : 502,
    retryable: ['timeout', 'provider_unavailable', 'rate_limited'].includes(providerCode),
    retryAfterMs: retryAfterMilliseconds(cause.response?.headers?.['retry-after']),
  });
  return error;
}
export function invalidProviderResponse() {
  return Object.assign(new Error('SerpApi returned an invalid response; the last verified fare was preserved.'), { providerCode: 'invalid_response', status: 502, retryable: false });
}

export async function serpApiRequest(params, { request = axios.get, pause = sleep, random = Math.random, apiKey = process.env.SERPAPI_API_KEY, maxAttempts = 2 } = {}) {
  const attempts = Number.isFinite(maxAttempts) ? Math.min(3, Math.max(1, Math.trunc(maxAttempts))) : 2;
  if (!apiKey) throw Object.assign(new Error('Flight search is not configured. SERPAPI_API_KEY is missing.'), { status: 503, providerCode: 'not_configured', retryable: false });
  const stateKey = `serpapi:cooldown:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  const blocked = await readProviderState(stateKey);
  if (blocked) throw Object.assign(new Error(`SerpApi is temporarily unavailable (${blocked.providerCode}).`), { status: 503, providerCode: blocked.providerCode, retryAfterMs: Math.max(0, blocked.until - Date.now()), retryable: blocked.providerCode === 'rate_limited' });
  if (active >= 4) throw Object.assign(new Error('Flight provider is busy. Retry shortly.'), { status: 503, providerCode: 'concurrency_limited', retryAfterMs: 1000, retryable: true });
  active++;
  let slotKey;
  let owner;
  try {
    if (providerStateAvailable()) {
      for (let index = 0; index < 4; index++) {
        const candidate = `serpapi:slot:${index}`;
        const claim = await claimProviderLease(candidate, 75000);
        if (claim) { slotKey = candidate; owner = claim; break; }
      }
      if (!owner) throw Object.assign(new Error('Flight provider is busy. Retry shortly.'), { status: 503, providerCode: 'concurrency_limited', retryAfterMs: 1000, retryable: true });
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      const limit = Number(process.env.SERPAPI_MAX_DAILY_REQUESTS);
      if (Number.isInteger(limit) && limit > 0 && providerStateAvailable()) {
        const day = new Date().toISOString().slice(0, 10);
        const bucket = await RateLimitBucket.findOneAndUpdate({ _id: `serpapi:budget:${day}` }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 2 * 86400000) } }, { upsert: true, returnDocument: 'after' }).lean();
        if (bucket.count > limit) throw Object.assign(new Error('SkyScout flight-search budget is reached for today.'), { status: 503, providerCode: 'quota_exceeded', retryable: false });
      }
      try {
        const timeout = params.engine === 'google_flights' ? 20000 : params.engine === 'google_news' ? 10000 : 9000;
        const url = 'https://serpapi.com/search.json';
        const options = { params: { ...params, api_key: apiKey }, timeout, maxContentLength: 4 * 1024 * 1024 };
        let response;
        try {
          response = await request(url, options);
        } catch (cause) {
          // If a configured local proxy refuses the connection, retry this request directly.
          // A working proxy remains the preferred transport; injected test requests stay isolated.
          if (request !== axios.get || cause.code !== 'ECONNREFUSED' || !proxyConfigured()) throw cause;
          response = await request(url, { ...options, proxy: false });
        }
        const data = response.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidProviderResponse();
        if (data.error) {
          if (/hasn't returned any results for this query/i.test(String(data.error))) {
            await persistOperation('serpapi', 'ok', { engine: params.engine, empty: true }).catch(() => {});
            return { ...response, data: { ...data, ...(params.engine === 'google_flights' ? { error: undefined, best_flights: [], other_flights: [] } : {}) } };
          }
          const quota = /quota|credit|run out|limit|searches.*exceed/i.test(String(data.error));
          throw providerError({ response: { status: quota ? 429 : 400, data, headers: response.headers } });
        }
        for (const field of ['best_flights', 'other_flights', 'booking_options', 'suggestions']) {
          if (data[field] !== undefined && !Array.isArray(data[field])) throw invalidProviderResponse();
        }
        await persistOperation('serpapi', 'ok', { engine: params.engine }).catch(() => {});
        return response;
      } catch (cause) {
        const error = providerError(cause);
        await persistOperation('serpapi', error.providerCode, { engine: params.engine, httpStatus: error.providerStatus, transportCode: cause.code || null }).catch(() => {});
        const wait = Math.max(error.retryAfterMs || 0, error.providerCode === 'rate_limited' ? 1000 : 0, 350 * 2 ** attempt + Math.floor(random() * 250));
        if (['rate_limited', 'quota_exceeded'].includes(error.providerCode)) {
          const until = Date.now() + Math.max(error.retryAfterMs || 0, error.providerCode === 'quota_exceeded' ? 6 * 3600000 : 1000);
          await storeProviderState(stateKey, { providerCode: error.providerCode, until }, until);
        }
        if (!error.retryable || attempt + 1 >= attempts || wait > 3000) throw error;
        await pause(wait);
      }
    }
  } finally {
    active--;
    if (slotKey) await releaseProviderLease(slotKey, owner);
  }
}
