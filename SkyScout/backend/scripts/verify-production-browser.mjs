// Browser checks of the real production bundle under the checked-in nginx CSP.
// The local HTTP adapter is a QA harness, not a replacement production server.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { browserSession, until } from './browser-session.mjs';

const output = process.env.QA_OUTPUT_DIR || '../docs/qa/readiness-2026-11-14';
const root = path.resolve('../dist');
const upstream = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api';
const policy = (await readFile('../deploy/nginx.conf', 'utf8')).match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
assert.ok(policy);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const evidence = { executedAt: new Date().toISOString(), source: 'Real production bundle, real browser, nginx-equivalent CSP and actual API/catalog; no paid providers', viewports: [], checks: {} };
const server = http.createServer(async (req, res) => {
  let requestPath;
  try {
    const url = new URL(req.url, 'http://127.0.0.1:5050');
    requestPath = url.pathname;
    if (url.pathname.startsWith('/api/') || ['/health', '/readyz'].includes(url.pathname)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
      const response = await fetch(new URL(url.pathname + url.search, upstream), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), signal: AbortSignal.timeout(65000) });
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (!['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(name)) res.setHeader(name, value);
      if (response.headers.getSetCookie().length) res.setHeader('set-cookie', response.headers.getSetCookie());
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
    if (!path.extname(file)) file = path.join(root, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': policy, 'Cache-Control': 'no-store' }).end(data);
  } catch (error) {
    if (requestPath?.startsWith('/api/')) {
      evidence.proxyFailures ||= [];
      evidence.proxyFailures.push({ path: requestPath, errorName: error.name, code: error.cause?.code || error.code || 'unknown' });
    }
    res.writeHead(requestPath?.startsWith('/api/') ? 502 : 404).end('Unavailable');
  }
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await new Promise((resolve) => server.listen(5050, '127.0.0.1', resolve));
  const airportResponse = await fetch(`${upstream.replace(/\/$/, '')}/flights/airports?q=Mumbai`);
  const airportPayload = await airportResponse.json();
  assert.equal(airportResponse.status, 200, 'production airport API response');
  assert.ok(airportPayload.data?.some((airport) => airport.iata === 'BOM'), 'production airport API returns Mumbai');
  evidence.checks.airportApiCatalog = true;
  browser = await browserSession(9241);
  const { call, evaluate, fill } = browser;
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp=[];window.__fetchTrace=[];window.__sessionOutage=false;document.addEventListener('securitypolicyviolation',e=>window.__csp.push({directive:e.violatedDirective,uri:e.blockedURI}));const originalFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const url=new URL(String(args[0]),location.href);if(window.__sessionOutage&&url.pathname.endsWith('/auth/me')){window.__fetchTrace.push({path:url.pathname,status:503,fixture:true});return new Response(JSON.stringify({message:'Controlled session service outage'}),{status:503,headers:{'Content-Type':'application/json'}})}try{const response=await originalFetch(...args);if(url.pathname.startsWith('/api/'))window.__fetchTrace.push({path:url.pathname,status:response.status});return response}catch(error){if(url.pathname.startsWith('/api/'))window.__fetchTrace.push({path:url.pathname,errorName:error.name,error:error.message});throw error}};` });
  await call('Page.navigate', { url: 'http://127.0.0.1:5050' });
  await until(() => evaluate(`Boolean(document.querySelector('#hero-title'))`), 'production home');
  await evaluate(`document.fonts.ready`);
  for (const width of [320, 360, 768, 1440]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 640 });
    await until(() => evaluate(`document.querySelector('figure img').complete && document.querySelector('figure img').naturalWidth>0`), 'local hero image');
    const layout = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,imageLoaded:document.querySelector('figure img').naturalWidth>0,fontLoaded:document.fonts.check('600 16px "Plus Jakarta Sans"'),mainCount:document.querySelectorAll('main').length})`);
    assert.ok(layout.scrollWidth <= layout.width + 1, `horizontal overflow at ${width}`);
    assert.equal(layout.imageLoaded, true); assert.equal(layout.fontLoaded, true); assert.equal(layout.mainCount, 1);
    evidence.viewports.push({ requestedWidth: width, ...layout });
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/home-${width}.png`, Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`localStorage.setItem('skyscout-theme','dark')`);
  await call('Page.reload');
  await until(() => evaluate(`Boolean(document.querySelector('#hero-title')) && document.documentElement.classList.contains('dark')`), 'dark theme reload');
  evidence.checks.darkThemeReload = true;
  const dark = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(`${output}/home-dark.png`, Buffer.from(dark.data, 'base64'));
  const id = await evaluate(`document.querySelector('#flight-search input[role="combobox"]').id`);
  await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
  await call('Input.insertText', { text: 'Mumbai' });
  try {
    await until(() => evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(e=>e.textContent.includes('BOM'))`), 'production Mumbai catalog');
  } catch (error) {
    evidence.airportAutocompleteDiagnostic = await evaluate(`({value:document.querySelector('#flight-search input[role="combobox"]')?.value,dropdown:document.querySelector('[role="listbox"]')?.innerText,status:document.querySelector('[role="listbox"] [role="status"]')?.innerText,fetchTrace:window.__fetchTrace,csp:window.__csp})`);
    throw error;
  }
  evidence.checks.catalogAutocomplete = true;
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  assert.match(await evaluate(`document.querySelector('#flight-search input[role="combobox"]').value`), /\(BOM\)$/);
  evidence.checks.keyboardAirportSelection = true;
  // Controlled fare/empty-return responses exercise recovery without provider spend.
  const date = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const returned = new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10);
  const fixture = { id: 'empty-return-qa', airline: 'QA flight fixture', flightNumber: 'QA100', from: 'BOM', to: 'DEL', departure: '09:00', arrival: '11:00', departureAt: date + ' 09:00', arrivalAt: date + ' 11:00', price: 5000, currency: 'INR', durationMinutes: 120, stops: 0, stopsLabel: 'Non-stop', departureRef: 'controlled-empty-return', segments: [] };
  await evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=(...args)=>String(args[0]).includes('/flights/search?')?Promise.resolve(new Response(JSON.stringify({success:true,data:[${JSON.stringify(fixture)}],searchedAt:new Date().toISOString()}),{headers:{'Content-Type':'application/json'}})):String(args[0]).includes('/flights/return-options/')?Promise.resolve(new Response(JSON.stringify({success:true,data:[]}),{headers:{'Content-Type':'application/json'}})):original(...args)})()`);
  const destinationId = await evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[1].id`);
  await evaluate(`document.getElementById(${JSON.stringify(destinationId)}).focus()`);
  await call('Input.insertText', { text: 'Delhi' });
  await until(() => evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(e=>e.textContent.includes('DEL'))`), 'destination catalog');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await evaluate(`document.querySelector('input[value="round-trip"]').click()`);
  await until(() => evaluate(`document.querySelectorAll('#flight-search input[type="date"]').length===2`), 'round-trip form');
  const dates = await evaluate(`Array.from(document.querySelectorAll('#flight-search input[type="date"]')).map(e=>e.id)`);
  await fill(`[id=${JSON.stringify(dates[0])}]`, date); await fill(`[id=${JSON.stringify(dates[1])}]`, returned);
  await evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.trim()==='Search flights').click()`);
  await until(() => evaluate(`Array.from(document.querySelectorAll('article button')).some(b=>b.textContent==='Choose outbound')`), 'outbound fixture');
  await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Choose outbound').click()`);
  await until(() => evaluate(`document.body.innerText.includes('No flights found for the selected route and dates.')`), 'empty onward offers');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Choose a different outbound').click()`);
  await until(() => evaluate(`Array.from(document.querySelectorAll('article button')).some(b=>b.textContent==='Choose outbound')`), 'outbound recovery');
  evidence.checks.emptyReturnRecovery = true;
  evidence.homeCspViolations = await evaluate('window.__csp');
  assert.deepEqual(evidence.homeCspViolations, []);
  // Explicit negative session fixture; all catalog and asset checks above are real.
  const outageScript = await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__sessionOutage=true;` });
  await call('Page.navigate', { url: 'http://127.0.0.1:5050/dashboard' });
  await until(() => evaluate(`Boolean(document.body?.innerText.includes('Your session could not be checked'))`), 'session outage disclosure');
  assert.equal(await evaluate('location.pathname'), '/dashboard');
  await evaluate(`window.__sessionOutage=false;Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Try again').click()`);
  await until(() => evaluate(`location.pathname==='/login'&&Boolean(document.querySelector('input[type="password"]'))`), 'session retry resolves actual guest');
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: outageScript.identifier });
  evidence.checks.sessionOutageAndRetry = true;
  evidence.cspViolations = await evaluate('window.__csp');
  assert.deepEqual(evidence.cspViolations, []);
  assert.deepEqual(browser.errors, []);
  evidence.runtimeExceptions = browser.errors;
} catch (error) {
  evidence.failure = error.message;
  if (error.message.includes('session')) evidence.sessionDiagnostic = await evaluate(`({path:location.pathname,authRequests:(window.__fetchTrace||[]).filter(request=>request.path.endsWith('/auth/me')),disclosure:Boolean(document.body?.innerText.includes('Your session could not be checked')),retryButton:Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Try again')})`).catch(() => null);
  process.exitCode = 1;
}
finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
  await mkdir(output, { recursive: true }); await writeFile(`${output}/production-browser.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
