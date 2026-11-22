import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/database.js';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import FareIntelligenceAnalysis from '../models/FareIntelligenceAnalysis.js';
import IntelligenceReport from '../models/IntelligenceReport.js';
import Notification from '../models/Notification.js';
import DisruptionPrediction from '../models/DisruptionPrediction.js';
import ProviderState from '../models/ProviderState.js';
import { buildFareBaseline } from '../services/fareBaseline.js';
import { buildDailyFare, backtestFare } from '../services/fareDaily.js';
import { reportIdentity, writeReport, readReport, recordReportAttempt } from '../services/intelligenceReports.js';

const api = 'http://127.0.0.1:5000/api';
const artifacts = path.resolve(process.env.QA_OUTPUT_DIR || '../docs/qa/production-2026-10-28');
const profile = path.resolve(`../qa-artifacts/fare-repair-${randomBytes(4).toString('hex')}`);
let cookie; let userId; let browser; let socket;
const evidence = { executedAt: new Date().toISOString(), live: {}, browser: {}, fixtures: {} };
async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${api}${route}`, { method, headers: { 'X-SkyScout-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(65000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route.replace(/[a-f0-9]{24}/g, ':id')} HTTP ${response.status}: ${payload.message}`);
  return { payload, response };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, attempts = 120) {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await pause(250); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await mkdir(artifacts, { recursive: true });
  await connectDB();
  const account = await request('/auth/register', { method: 'POST', body: { name: 'Fare repair verification', email: `fare-repair-${randomBytes(8).toString('hex')}@example.test`, password: randomBytes(24).toString('base64url') } });
  userId = new mongoose.Types.ObjectId(account.payload.user.id);
  cookie = account.response.headers.getSetCookie()[0].split(';')[0];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const addDay = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  // Use a verified holiday date where still in the future; never create a fake search result.
  const departureDate = today < '2026-10-20' ? '2026-11-08' : addDay(28);
  const query = (date) => `/flights/search?origin=DEL&destination=BLR&date=${date}&tripType=one-way&adults=1&children=0&infants=0&travelClass=1&currency=INR`;
  const search = (await request(query(departureDate))).payload;
  assert.ok(search.data.length, 'Real future flight offers required');
  const offer = search.data.find((item) => item.stops === 0) || search.data[0];
  const tracked = (await request('/tracked-flights', { method: 'POST', body: { trackRef: offer.trackRef } })).payload.data;
  const id = tracked._id;
  evidence.live.search = { status: 200, route: 'DEL–BLR', departureDate, count: search.data.length, selectedAirline: offer.airline, selectedFlight: offer.flightNumber, price: offer.price, currency: offer.currency, searchedAt: search.searchedAt };
  const market = (await request(`/tracked-flights/${id}/fare-intelligence/market`)).payload.market;
  const baseline = (await request(`/tracked-flights/${id}/fare-intelligence`)).payload;
  const explorer = (await request(`/tracked-flights/${id}/fare-intelligence?mode=assumption&market=normal`)).payload;
  assert.equal(explorer.daily.points.length, 15);
  assert.equal(explorer.baseline.currentFare, market.matchedFare || offer.price);
  for (const day of [1, 2, 3, 4, 7, 14]) assert.equal(explorer.daily.points[day].central, Math.round(explorer.baseline.currentFare * Math.exp(Math.log1p(0.001) * day)));
  evidence.live.market = { status: market.status, offers: market.offers?.length, matchedFare: market.matchedFare, matchStatus: market.matchStatus, quotedAt: market.quotedAt, cached: market.cached };
  evidence.live.baseline = { status: baseline.baseline.status, observations: baseline.baseline.observationCount, bookingDays: baseline.baseline.bookingDayCount, currency: baseline.baseline.currency };
  evidence.live.daily = { mode: explorer.daily.mode, count: explorer.daily.points.length, checkedDays: [1, 2, 3, 4, 7, 14], eventAdjustment: 0 };
  evidence.live.calendar = baseline.calendarContext;
  // Inspect genuine existing historical series read-only, without adding synthetic observations.
  const historical = process.env.QA_INCLUDE_EXISTING_HISTORY === 'true' ? await TrackedFlight.find({ userId: { $ne: userId } }).lean() : [];
  evidence.live.genuineHistory = [];
  for (const flight of historical) {
    const observations = await PriceObservation.find({ userId: flight.userId, trackedFlightId: flight._id }).sort({ observedAt: 1 }).lean();
    if (observations.length < 2) continue;
    const base = buildFareBaseline(flight, observations);
    evidence.live.genuineHistory.push({ route: `${flight.origin}–${flight.destination}`, departureDate: flight.departureDate, count: observations.length, distinctBookingDays: base.bookingDayCount, observedDays: buildDailyFare(base).points.map((point) => point.day), backtest: backtestFare(flight, observations) });
  }

  await mkdir(profile, { recursive: true });
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9234', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let tab;
  await until(async () => { try { tab = await (await fetch('http://127.0.0.1:9234/json/new?about:blank', { method: 'PUT' })).json(); return Boolean(tab.webSocketDebuggerUrl); } catch { return false; } }, 'Chrome startup');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let seq = 0; const errors = []; const network = []; const responseIds = []; let fixture = null;
  const call = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++seq; const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 20000); pending.set(requestId, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/api/')) {
      network.push({ status: message.params.response.status, path: new URL(message.params.response.url).pathname.replace(/[a-f0-9]{24}/g, ':id') });
      if (message.params.response.url.includes('/fare-intelligence/research')) responseIds.push(message.params.requestId);
    }
    if (message.method === 'Fetch.requestPaused') {
      const request = message.params.request;
      const response = fixture && request.method !== 'OPTIONS' && request.url.includes('/fare-intelligence/research') ? fixture : null;
      const action = response ? call('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: 'http://127.0.0.1:5173' }, { name: 'Access-Control-Allow-Credentials', value: 'true' }], body: Buffer.from(JSON.stringify(response)).toString('base64') }) : call('Fetch.continueRequest', { requestId: message.params.requestId });
      action.catch((error) => errors.push(error.message));
    }
    if (!message.id || !pending.has(message.id)) return;
    const job = pending.get(message.id); pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const fareSelector = 'section[aria-label="Fare Intelligence"]';
  const fareText = () => evaluate(`document.querySelector('${fareSelector}')?.innerText || ''`);
  await call('Network.enable'); await call('Runtime.enable'); await call('Page.enable');
  const [name, value] = cookie.split('='); await call('Network.setCookie', { name, value, url: 'http://127.0.0.1:5000', sameSite: 'Lax' });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: 'http://127.0.0.1:5173/dashboard' });
  await until(async () => (await fareText()).includes('Comparable flight offers'), 'dashboard fare card');
  await until(async () => !(await fareText()).includes('Checking real flight offers'), 'live market evidence', 200);
  await until(async () => !(await fareText()).includes('Researching automatically'), 'automatic Gemini research', 200);
  await until(async () => network.some((item) => item.path.endsWith("/fare-intelligence/research")), "automatic research response", 220);
  evidence.browser.automaticResearch = network.some((item) => item.path.endsWith('/fare-intelligence/research'));
  assert.equal(evidence.browser.automaticResearch, true);
  await pause(100);
  const autoBody = JSON.parse((await call('Network.getResponseBody', { requestId: responseIds.at(-1) })).body);
  const autoResearch = autoBody.eventIntelligence;
  evidence.live.gemini = { status: autoResearch.status, checkedAt: autoResearch.checkedAt, events: autoResearch.events?.length || 0, diagnostics: autoResearch.diagnostics, storageAuthorized: autoResearch.storageAuthorized };
  evidence.browser.liveEventCards = await evaluate(`document.querySelectorAll('${fareSelector} article').length`);
  await evaluate(`(() => { const select = document.querySelector('select[aria-label="Fare evidence view"]'); select.value = 'assumption'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(async () => (await fareText()).includes('Day 4'), 'assumption day controls');
  await evaluate(`Array.from(document.querySelectorAll('${fareSelector} button')).find((button) => button.textContent === '14 days').click()`);
  await until(async () => (await fareText()).includes('Day 14'), '14 day selector');
  await evaluate(`Array.from(document.querySelectorAll('${fareSelector} button')).find((button) => button.textContent === 'Day 4').click()`);
  const selectedText = await evaluate(`document.querySelector('[aria-label="Selected day analysis"]').innerText`);
  assert.match(selectedText, /Day 4/);
  assert.ok(selectedText.includes(new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(explorer.daily.points[4].central)));
  evidence.browser.day4MatchesBackend = true;
  evidence.browser.graphs = await evaluate(`Array.from(document.querySelectorAll('${fareSelector} [role="img"]')).map((element) => element.getAttribute('aria-label'))`);
  assert.ok(evidence.browser.graphs.some((name) => name.includes('day-wise')));
  assert.ok(evidence.browser.graphs.some((name) => name.includes('Observed fare')));
  assert.ok(evidence.browser.graphs.some((name) => name.includes('Comparable flight')));
  // Move the graph into the viewport before dispatching real pointer events.
  await evaluate(`document.querySelector('[aria-label="Interactive day-wise fare scenario graph"]').scrollIntoView({ block: 'center' })`);
  await pause(200);
  const chart = await evaluate(`(() => { const rect = document.querySelector('[aria-label="Interactive day-wise fare scenario graph"] .recharts-wrapper').getBoundingClientRect(); return { x: rect.left + 75 + (rect.width - 90) * .5, y: rect.top + rect.height * .45 }; })()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chart.x, y: chart.y }); await pause(400);
  evidence.browser.tooltip = await evaluate(`Boolean(Array.from(document.querySelectorAll('.recharts-tooltip-wrapper')).find((element) => element.innerText.includes('Central') && element.innerText.includes('Event effects are qualitative'))) `);
  assert.equal(evidence.browser.tooltip, true);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: chart.x, y: chart.y });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: chart.x, y: chart.y });
  await pause(200);
  evidence.browser.graphClickSelectsDay = await evaluate(`document.querySelector('[aria-label="Selected day analysis"]').innerText.includes('Day 7')`);
  assert.equal(evidence.browser.graphClickSelectsDay, true);
  for (const day of [1, 3, 4, 7]) {
    await evaluate(`Array.from(document.querySelectorAll('${fareSelector} button')).find((button) => button.textContent === 'Day ${day}').click()`);
    const text = await evaluate(`document.querySelector('[aria-label="Selected day analysis"]').innerText`);
    assert.ok(text.includes(new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(explorer.daily.points[day].central)));
  }
  evidence.browser.selectedDaysMatchBackend = [1, 3, 4, 7];
  await evaluate(`Array.from(document.querySelectorAll('${fareSelector} button')).find((button) => button.textContent === 'Day 4').click()`);
  await evaluate(`document.querySelector('${fareSelector}').scrollIntoView()`); await pause(200);
  const screenshot = async (filename) => { const captured = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(artifacts, filename), Buffer.from(captured.data, 'base64')); };
  await screenshot('live-desktop.png');
  await evaluate(`document.querySelector('[aria-label="Observed fare chart with ${baseline.priceHistory.length} real price observations"]')?.scrollIntoView()`);
  await screenshot('live-history-market.png');
  await evaluate(`document.querySelector('${fareSelector}').scrollIntoView()`);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await pause(300);
  await evaluate(`document.querySelector('${fareSelector}').scrollIntoView()`);
  evidence.browser.mobileOverflow = await evaluate('document.documentElement.scrollWidth > window.innerWidth');
  if (evidence.browser.mobileOverflow) evidence.browser.overflowElements = await evaluate(`Array.from(document.querySelectorAll('body *')).filter((element) => { const rect = element.getBoundingClientRect(); return rect.right > innerWidth + 2 && getComputedStyle(element).position !== 'fixed' && !element.closest('[class*="overflow-x-auto"]'); }).slice(0, 12).map((element) => ({ tag: element.tagName, className: String(element.className).slice(0, 100), text: element.innerText?.slice(0, 80), right: element.getBoundingClientRect().right }))`);
  await screenshot('live-mobile.png');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.documentElement.classList.add('dark')`); await pause(200); await screenshot('live-dark.png');
  await evaluate(`document.documentElement.classList.remove('dark')`);
  const research = (await request(`/tracked-flights/${id}/fare-intelligence/research`, { method: 'POST' })).payload.eventIntelligence;
  evidence.live.researchRefresh = { status: research.status, checkedAt: research.checkedAt };
  console.log('QA: live fare graphs checked; checking destination');
  const journey = (await request(`/tracked-flights/${id}/destination-intelligence?finalDestination=Koramangala`)).payload;
  evidence.live.destination = { cityAvailable: journey.available, cityEvents: journey.events?.length, routing: journey.journey?.routing, researchStatus: journey.journey?.research?.status, geometryStatus: journey.journey?.research?.geometryStatus };
  await evaluate(`document.querySelector('input[placeholder="Koramangala"]').focus()`);
  await call('Input.insertText', { text: 'Koramangala' });
  await pause(200);
  await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Check journey').click()`);
  await until(async () => evaluate(`document.body.innerText.includes('GOOGLE_MAPS_API_KEY')`), 'exact missing routing dependency', 200);
  evidence.browser.destinationDependencyRendered = true;

  // Isolated browser-only fixture: production API and saved dashboard data remain real.
  const eventDate = explorer.daily.points[4].date;
  const event = { id: 'explicit-qa-event', title: 'QA FIXTURE: synthetic event, not live news', category: 'airport', summary: 'Synthetic test of citation and event-timeline rendering only.', eventStart: eventDate, eventEnd: eventDate, location: 'Bengaluru', sourceTitle: 'Example test source', sourceUrl: 'https://example.org/qa-fixture', publishedAt: today, researchedAt: new Date().toISOString(), impactDirection: 'uncertain', impactExplanation: 'Test context has no quantified fare adjustment.', relevance: { level: 'DIRECT', reason: 'Test fixture only.' } };
  fixture = { ...explorer, eventIntelligence: { status: 'grounded_result', events: [event], checkedAt: new Date().toISOString(), searchSuggestionsHtml: '<div>QA FIXTURE: Search Suggestions rendering test</div>', storageAuthorized: false } };
  await call('Fetch.enable', { patterns: [{ urlPattern: '*fare-intelligence/research*', requestStage: 'Request' }] });
  await evaluate(`Array.from(document.querySelectorAll('${fareSelector} button')).find((button) => button.textContent === 'Refresh research').click()`);
  await until(async () => (await fareText()).includes(event.title), 'fixture event card');
  evidence.fixtures.groundedEventRendered = await evaluate(`Boolean(document.querySelector('${fareSelector} article a[href="https://example.org/qa-fixture"]'))`);
  evidence.fixtures.suggestionsRendered = await evaluate(`document.querySelector('iframe[title="Google Search Suggestions"]').srcdoc.includes('QA FIXTURE')`);
  fixture = { ...explorer, eventIntelligence: { status: 'quota_exceeded', checkedAt: new Date().toISOString() } };
  await evaluate(`Array.from(document.querySelectorAll('${fareSelector} button')).find((button) => button.textContent === 'Refresh research').click()`);
  await until(async () => (await fareText()).includes('Research quota reached'), 'fixture failure notice');
  evidence.fixtures.reportSurvivesFailure = (await fareText()).includes(event.title);
  assert.equal(evidence.fixtures.reportSurvivesFailure, true);
  await evaluate(`document.querySelector('${fareSelector} article').scrollIntoView()`); await screenshot('fixture-event-rendering.png');
  fixture = null; await call('Fetch.disable');
  // Synthetic storage test only: no Google result is persisted or substituted into the app.
  const storageSetting = process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED;
  process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED = 'true';
  try {
    const identity = reportIdentity({ ...tracked, userId }, 'qa-synthetic-storage');
    await writeReport(identity, { ...tracked, userId }, { status: 'grounded_result', events: [event], checkedAt: new Date().toISOString() });
    await recordReportAttempt(identity.key, { status: 'quota_exceeded' });
    const stored = await readReport(identity.key);
    assert.equal(stored.report.events[0].id, event.id);
    assert.equal(stored.lastAttempt.status, 'quota_exceeded');
    evidence.fixtures.mongoPersistence = { syntheticReportSavedAndRead: true, successfulReportSurvivesFailure: true };
  } finally {
    if (storageSetting === undefined) delete process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED;
    else process.env.GEMINI_GROUNDED_STORAGE_AUTHORIZED = storageSetting;
  }
  console.log('QA: fixture retention checked; checking tomorrow flight');
  const tomorrowSearch = (await request(query(addDay(1)))).payload;
  if (tomorrowSearch.data.length) {
    const nextFlight = (await request('/tracked-flights', { method: 'POST', body: { trackRef: tomorrowSearch.data[0].trackRef } })).payload.data;
    const result = (await request(`/tracked-flights/${nextFlight._id}/fare-intelligence?mode=assumption`)).payload;
    assert.deepEqual(result.daily.points.map((point) => point.day), [0]);
    evidence.live.tomorrow = { departureDate: nextFlight.departureDate, quote: result.baseline.currentFare, daysUntilDeparture: result.baseline.daysUntilDeparture, pointDays: result.daily.points.map((point) => point.day) };
  } else evidence.live.tomorrow = { status: 'no_live_offers_returned' };
  evidence.browser.runtimeErrors = errors;
  evidence.browser.network = network;
  assert.deepEqual(errors, []);
  assert.equal(evidence.browser.mobileOverflow, false);
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.failure = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(evidence, null, 2));
  socket?.close();
  if (browser) { browser.kill(); await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), pause(2000)]); }
  if (profile.startsWith(path.resolve('../qa-artifacts') + path.sep)) await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (userId) {
    await Promise.all([PriceObservation, FareIntelligenceAnalysis, IntelligenceReport, Notification, DisruptionPrediction, TrackedFlight, AuthSession].map((model) => model.deleteMany({ userId })));
    await ProviderState.deleteMany({ key: { $regex: `^fare-market:${userId}:` } });
    await User.deleteOne({ _id: userId });
  }
  await mongoose.disconnect();
}
