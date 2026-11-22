// Read-only account probe and isolated production-mode API startup. No secrets
// or raw provider responses are written to evidence.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { until } from './browser-session.mjs';

const output = process.env.QA_OUTPUT_DIR || '../docs/qa/final-production-2026-11-03';
const evidence = { executedAt: new Date().toISOString(), configured: {
  serpApi: Boolean(process.env.SERPAPI_API_KEY), gemini: Boolean(process.env.GEMINI_API_KEY), maps: Boolean(process.env.GOOGLE_MAPS_API_KEY),
  groundedReportStorageAuthorized: process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED === 'true',
} };
let child;
try {
  if (process.env.SERPAPI_API_KEY) {
    const url = new URL('https://serpapi.com/account.json'); url.searchParams.set('api_key', process.env.SERPAPI_API_KEY);
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) }); const body = await response.json();
    evidence.serpApi = { status: response.status, accepted: response.ok && !body.error, totalSearchesLeft: body.total_searches_left, monthlyAllowance: body.searches_per_month };
    assert.equal(evidence.serpApi.accepted, true);
  }
  child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production', PORT: '5057', MONITORING_ENABLED: 'false', CLIENT_ORIGINS: 'https://skyscout.example', CLIENT_ORIGIN: 'https://skyscout.example' } });
  let launchError; child.on('error', error => { launchError = error; });
  await until(async () => {
    if (launchError) throw launchError;
    try { return (await fetch('http://127.0.0.1:5057/readyz', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, 'production-mode API readiness', 100);
  const response = await fetch('http://127.0.0.1:5057/health');
  evidence.productionStartup = { healthStatus: response.status, ready: true, monitoringInApi: false, transport: 'local HTTP process check; deployed HTTPS/proxy cookies not tested' };
  assert.equal(response.status, 200);
} catch (error) { evidence.failure = error.name === 'AssertionError' ? error.message : error.name; process.exitCode = 1; }
finally {
  child?.kill();
  await mkdir(output, { recursive: true }); await writeFile(`${output}/release-runtime.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
}
