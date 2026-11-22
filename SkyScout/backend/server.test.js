import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('port conflict exits with a safe startup error instead of reporting a running API', async () => {
  const occupied = createServer();
  occupied.listen(0); await once(occupied, 'listening');
  let child; let timeout;
  try {
    child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url),
      env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: '', PORT: String(occupied.address().port), MONITORING_ENABLED: 'false', TRUST_PROXY: '0', SESSION_SAME_SITE: 'Lax' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
    timeout = setTimeout(() => child.kill(), 8000);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1); assert.match(output, /api_start_failed/); assert.match(output, /EADDRINUSE/);
    assert.doesNotMatch(output, /api_started/);
  } finally { clearTimeout(timeout); child?.kill(); await new Promise((resolve) => occupied.close(resolve)); }
});
