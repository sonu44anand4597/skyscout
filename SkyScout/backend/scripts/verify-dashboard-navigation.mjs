// Deterministic browser fixtures; real sessions, tracking, calculations and MongoDB.
// The browser alone intercepts paid/optional providers. Production handlers are unchanged.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import connectDB, { closeDatabase } from '../config/database.js';
import { browserSession, until, pause } from './browser-session.mjs';
import ProviderState from '../models/ProviderState.js';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import Notification from '../models/Notification.js';
import DisruptionPrediction from '../models/DisruptionPrediction.js';
import FareIntelligenceAnalysis from '../models/FareIntelligenceAnalysis.js';
import IntelligenceReport from '../models/IntelligenceReport.js';

const web = process.env.E2E_WEB_URL || 'http://127.0.0.1:5173';
const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api';
const output = process.env.QA_OUTPUT_DIR || '../docs/qa/final-production-2026-11-03';
const date = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
const accounts = [1, 2].map(() => ({ email: `navigation-${randomUUID()}@example.test`, password: randomUUID() }));
const refs = [randomUUID(), randomUUID()];
const observedAt = new Date().toISOString();
const fixtures = [120, 180].map((durationMinutes, i) => ({ id: `navigation-fixture-${i}`, from: 'BOM', to: 'DEL', fromName: 'Mumbai', toName: 'Delhi', airline: i ? 'QA cheaper fixture' : 'QA faster fixture', flightNumber: `QA ${101 + i}`, departure: '09:00', arrival: i ? '12:00' : '11:00', departureAt: `${date} 09:00`, arrivalAt: `${date} ${i ? '12:00' : '11:00'}`, durationMinutes, stops: 0, stopsLabel: 'Non-stop', price: i ? 8500 : 10500, currency: 'INR', travelClass: 'Economy', trackRef: refs[i], quoteObservedAt: observedAt, segments: [{ flightNumber: `QA ${101 + i}`, airline: i ? 'QA cheaper fixture' : 'QA faster fixture', origin: { code: 'BOM', time: `${date} 09:00` }, destination: { code: 'DEL', time: `${date} ${i ? '12:00' : '11:00'}` }, durationMinutes }] }));
const evidence = { executedAt: observedAt, source: 'Controlled browser fares/optional providers; actual airport catalog, HTTP auth/tracking/ownership/calculation and MongoDB', checks: {} };
let browser; let trackedId;
try {
  await mkdir(output, { recursive: true }); await connectDB();
  for (const flight of fixtures) await ProviderState.create({ key: `track:${flight.trackRef}`, payload: { flight, context: { tripType: 'one-way', departureDate: date, adults: 1, children: 0, infants: 0, travelClass: 1, quoteObservedAt: observedAt }, expiresAt: Date.now() + 3600000 }, expiresAt: new Date(Date.now() + 3600000) });
  browser = await browserSession(9239); const { call, evaluate, fill } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original=window.fetch.bind(window);window.__qaDocument=crypto.randomUUID();window.__qaRequests=[];window.__qaMode='success';
    window.fetch=async(...args)=>{
      const url=new URL(String(args[0]),location.href);let response;
      if(url.pathname==='/api/flights/search'){
        if(window.__qaMode==='slow')await new Promise(r=>setTimeout(r,1500));
        response=new Response(JSON.stringify(window.__qaMode==='error'?{message:'Controlled provider quota outage',code:'quota_exceeded'}:{success:true,data:window.__qaMode==='empty'?[]:${JSON.stringify(fixtures)},searchedAt:${JSON.stringify(observedAt)}}),{status:window.__qaMode==='error'?503:200,headers:{'Content-Type':'application/json'}});
      }else if(window.__qaHistoryFailure&&url.pathname.endsWith('/history'))response=new Response(JSON.stringify({message:'Controlled history storage outage'}),{status:503,headers:{'Content-Type':'application/json'}});
      else if(url.pathname.endsWith('/fare-intelligence/research'))response=new Response(JSON.stringify({success:true,eventIntelligence:{status:'disabled',events:[]}}));
      else if(url.pathname.endsWith('/fare-intelligence/market'))response=new Response(JSON.stringify({success:true,market:{status:'not_checked',message:'Controlled browser test: paid market refresh disabled'}}));
      else if(url.pathname.endsWith('/destination-intelligence'))response=new Response(JSON.stringify({success:true,available:false,events:[],journey:{status:'not_configured',message:'Controlled missing Maps provider'}}));
      else if(url.pathname.endsWith('/weather'))response=new Response(JSON.stringify({success:true,airports:[]}));
      else if(url.pathname.endsWith('/prediction'))response=new Response(JSON.stringify({success:true,available:false,message:'Controlled optional-service outage'}));
      else response=await original(...args);
      if(url.pathname.startsWith('/api/')){const entry={path:url.pathname,status:response.status};window.__qaRequests.push(entry);response.clone().json().then(body=>{entry.body=body;entry.done=true}).catch(()=>entry.done=true)}return response;
    };
  })();` });
  const shot = async name => { const r = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(`${output}/${name}.png`, Buffer.from(r.data, 'base64')); };
  async function home(mode = 'success') {
    const url = `${web}/?navigationQa=${randomUUID()}#flight-search`; await call('Page.navigate', { url });
    await until(() => evaluate(`location.href===${JSON.stringify(url)}&&document.querySelectorAll('#flight-search input[role="combobox"]').length===2`), 'fresh search form');
    await evaluate(`window.__qaMode=${JSON.stringify(mode)}`);
  }
  async function choose(index, query, code) {
    const id = await evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[${index}].id`);
    await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`); await fill(`[id=${JSON.stringify(id)}]`, query);
    await until(() => evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(a=>a.innerText.includes('${code}'))`), `catalog ${code}`);
    const rect = await evaluate(`(()=>{const el=Array.from(document.querySelectorAll('[role="option"]')).find(a=>a.innerText.includes('${code}'));el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
    await until(() => evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[${index}].value.endsWith('(${code})')`), `selection ${code}`);
  }
  async function search(mode = 'success') {
    await home(mode); await choose(0, 'mumbai', 'BOM'); await choose(1, 'Delhi', 'DEL'); await fill('#flight-search input[type="date"]', date);
    await evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.trim()==='Search flights').click()`);
    await until(() => evaluate(`location.pathname==='/results'&&Boolean(document.querySelector('nav[aria-label="Flight results actions"] a'))`), 'results Dashboard link');
  }
  const clickDashboard = () => evaluate(`document.querySelector('nav[aria-label="Flight results actions"] a').click()`);
  const searchCount = () => evaluate(`window.__qaRequests.filter(r=>r.path==='/api/flights/search').length`);
  async function authenticatedDashboard() { await until(() => evaluate(`location.pathname==='/dashboard'&&Boolean(document.body?.innerText.includes('Notifications'))`), 'authenticated dashboard'); }

  console.log('Navigation QA: Dashboard in loading/error/empty states and guest login return');
  await search('slow'); assert.ok(await evaluate(`!document.querySelector('article')`)); evidence.checks.loadingButton = true;
  await clickDashboard(); await until(() => evaluate(`location.pathname==='/login'&&Boolean(document.querySelector('input[type="password"]'))`), 'guest protected route and rendered login form');
  assert.equal(await evaluate(`history.state.usr.from`), '/dashboard'); evidence.checks.guestLoginReturn = true;
  await evaluate(`Array.from(document.querySelectorAll('a')).find(a=>a.textContent==='Create an account').click()`);
  await until(() => evaluate(`Boolean(document.querySelector('input[autocomplete="name"]'))`), 'registration');
  await fill('input[autocomplete="name"]', 'Navigation QA'); await fill('input[type="email"]', accounts[0].email); await fill('input[type="password"]', accounts[0].password);
  await evaluate(`document.querySelector('form button').click()`); await authenticatedDashboard(); accounts[0].id = (await User.findOne({ email: accounts[0].email }).lean())._id;
  evidence.checks.registrationReturnsToDashboard = true;
  for (const mode of ['empty', 'error']) {
    await search(mode); await until(() => evaluate(mode === 'empty' ? `document.body.innerText.includes('No flights found for the selected route and dates.')` : `document.body.innerText.includes('Controlled provider quota outage')`), mode);
    assert.ok(await evaluate(`Boolean(document.querySelector('nav[aria-label="Flight results actions"] a[href="/dashboard"]'))`)); evidence.checks[`${mode}Button`] = true; await shot(`dashboard-button-${mode}`);
  }

  console.log('Navigation QA: client navigation, browser Back, filters and actual tracking');
  await search(); await until(() => evaluate(`document.querySelectorAll('article').length===2`), 'fixture results');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Fastest').click()`);
  await until(() => evaluate(`document.querySelector('article').innerText.includes('QA faster fixture')`), 'fastest sorting');
  await evaluate(`(()=>{const select=document.querySelector('#max-flight-duration');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'120');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await until(() => evaluate(`document.querySelectorAll('article').length===1`), 'duration filter');
  evidence.checks.durationFilter = true;
  const documentId = await evaluate('window.__qaDocument'); const requests = await searchCount(); const authRequests = await evaluate(`window.__qaRequests.filter(r=>r.path==='/api/auth/me').length`);
  await shot('dashboard-button-desktop'); await clickDashboard(); await authenticatedDashboard();
  assert.equal(await evaluate('window.__qaDocument'), documentId, 'client-side navigation');
  await evaluate('history.back()'); await until(() => evaluate(`location.pathname==='/results'&&Boolean(document.querySelector('article'))`), 'Back to results');
  assert.equal(await searchCount(), requests); assert.equal(await evaluate(`window.__qaRequests.filter(r=>r.path==='/api/auth/me').length`), authRequests);
  assert.ok(await evaluate(`document.querySelector('article').innerText.includes('QA faster fixture')`)); evidence.checks.backPreservesFiltersWithoutSearchOrAuthRefetch = true;
  assert.equal(await evaluate(`document.querySelector('#max-flight-duration').value`), '120');
  await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Track this flight').click()`);
  await until(async () => Boolean(await TrackedFlight.exists({ userId: accounts[0].id })), 'real tracking');
  const tracked = await TrackedFlight.findOne({ userId: accounts[0].id }).lean(); trackedId = tracked._id;
  assert.equal(tracked.currentPrice, 10500); assert.equal(tracked.origin, 'BOM'); assert.equal(tracked.destination, 'DEL');
  await until(() => evaluate(`document.querySelector('nav[aria-label="Flight results actions"] a').getAttribute('href')==='/dashboard?flight=${trackedId}'`), 'tracked context link');
  await clickDashboard(); await authenticatedDashboard();
  await until(() => evaluate(`Boolean(document.querySelector('#tracked-flight-${trackedId}'))&&Boolean(document.querySelector('[aria-label="Select fare day"] button'))`), 'saved selected itinerary and fare controls');
  evidence.checks.trackedContextAndPersistence = true;
  await evaluate(`window.__qaHistoryFailure=true;document.querySelector('button[aria-label="Refresh dashboard"]').click()`);
  await until(() => evaluate(`document.querySelector('#tracked-flight-${trackedId}')?.innerText.includes('History could not be refreshed')`), 'history failure disclosure');
  await evaluate(`window.__qaHistoryFailure=false;document.querySelector('button[aria-label="Refresh dashboard"]').click()`);
  await until(() => evaluate(`Boolean(document.querySelector('#tracked-flight-${trackedId}'))&&!document.querySelector('#tracked-flight-${trackedId}').innerText.includes('History could not be refreshed')`), 'history retry');
  evidence.checks.historyFailureAndRetry = true;
  const baseline = await evaluate(`(async()=>{const r=await fetch('${api}/tracked-flights/${trackedId}/fare-intelligence?mode=assumption&market=normal',{credentials:'include'});return r.json()})()`);
  assert.equal(baseline.baseline.currentFare, 10500);
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="Fare Intelligence"] button')).find(b=>b.textContent==='14 days').click()`);
  for (const day of [1, 3, 4, 7, 14]) {
    await evaluate(`Array.from(document.querySelectorAll('[aria-label="Select fare day"] button')).find(b=>b.textContent==='Day ${day}').click()`);
    const expected = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(baseline.daily.points[day].central);
    await until(() => evaluate(`document.querySelector('[aria-label="Selected day analysis"]').innerText.includes(${JSON.stringify(expected)})`), `day ${day}`);
  }
  assert.ok(await evaluate(`Boolean(document.querySelector('[aria-label="Interactive day-wise fare scenario graph"]'))`)); evidence.checks.dayControlsMatchBackend = true;
  await evaluate(`document.querySelector('[aria-label="Interactive day-wise fare scenario graph"]').scrollIntoView({block:'center'})`);
  const hover = await evaluate(`(()=>{const c=document.querySelectorAll('[aria-label="Interactive day-wise fare scenario graph"] .recharts-line-dots')[0].querySelectorAll('circle')[4];const r=c.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hover });
  const expectedHover = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(baseline.daily.points[4].central);
  await until(() => evaluate(`document.querySelector('[aria-label="Interactive day-wise fare scenario graph"] .recharts-tooltip-wrapper')?.innerText.includes(${JSON.stringify(expectedHover)})`), 'hover fare agrees with backend');
  evidence.checks.fareHoverTooltip = true;
  await evaluate('history.back()'); await until(() => evaluate(`location.pathname==='/results'&&Boolean(document.querySelector('article'))`), 'tracked Back');
  assert.equal(await searchCount(), requests); assert.ok(await evaluate(`document.querySelector('article').innerText.includes('Tracking')`));
  evidence.checks.backPreservesTrackingWithoutDuplicateRecord = (await TrackedFlight.countDocuments({ userId: accounts[0].id })) === 1;
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate(`!document.body.innerText.includes('Flight added to your watchlist.')`), 'tracking toast dismissed');
  await evaluate('window.scrollTo(0,0)'); await until(() => evaluate('window.scrollY===0'), 'mobile page top');
  const rect = await evaluate(`(()=>{const r=document.querySelector('nav[aria-label="Flight results actions"] a').getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom}})()`);
  assert.ok(rect.left >= 0 && rect.right <= 360 && rect.width >= 100 && rect.top >= 0 && rect.bottom <= 800); await shot('dashboard-button-mobile-light');
  await evaluate(`document.querySelector('nav[aria-label="Flight results actions"] button[aria-label^="Switch to"]').click()`);
  assert.equal(await evaluate(`document.documentElement.classList.contains('dark')`), true); await shot('dashboard-button-mobile-dark'); evidence.checks.mobileAndDarkMode = true;
  await call('Emulation.setDeviceMetricsOverride', { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false });
  const tablet = await evaluate(`(()=>{const r=document.querySelector('nav[aria-label="Flight results actions"] a').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
  assert.ok(tablet.left >= 0 && tablet.right <= 768 && tablet.top >= 0 && tablet.bottom <= 1024); await shot('dashboard-button-tablet'); evidence.checks.tabletLayout = true;
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await clickDashboard(); await authenticatedDashboard();
  // Keep the selected record outside the newest page to exercise reload lookup.
  await TrackedFlight.insertMany(Array.from({ length: 21 }, (_, index) => ({ userId: accounts[0].id, fingerprint: `pagination-${randomUUID()}`, origin: 'BOM', destination: 'DEL', departureDate: date, initialPrice: 8000 + index, currentPrice: 8000 + index, currency: 'INR', status: 'paused' })));
  await call('Page.reload'); await authenticatedDashboard();
  await until(() => evaluate(`Boolean(document.querySelector('#tracked-flight-${trackedId}'))`), 'dashboard reload persistence'); evidence.checks.dashboardRefresh = true;
  evidence.checks.selectionOutsideFirstPage = true;
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Interactive day-wise fare scenario graph"] svg'))`), 'mobile fare graph');
  assert.ok(await evaluate(`(()=>{const p=document.querySelector('[aria-label="Fare Intelligence"]');return p.scrollWidth<=p.clientWidth+1})()`), 'Fare Intelligence fits mobile width');
  await evaluate(`document.querySelector('[aria-label="Fare Intelligence"]').scrollIntoView({block:'start'})`); await shot('fare-intelligence-mobile');
  evidence.checks.mobileFareGraph = true;
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  console.log('Navigation QA: two-user ownership, edit and removal');
  const response = await fetch(`${api}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SkyScout-Request': '1' }, body: JSON.stringify({ name: 'Second navigation QA', ...accounts[1] }) });
  assert.equal(response.status, 201); accounts[1].id = (await response.json()).user.id; const cookie = response.headers.getSetCookie()[0].split(';')[0];
  for (const path of [`/tracked-flights/${trackedId}/history`, `/tracked-flights/${trackedId}/fare-intelligence`]) assert.equal((await fetch(api + path, { headers: { Cookie: cookie } })).status, 404);
  evidence.checks.accountIsolation = true;
  await evaluate(`document.querySelector('#tracked-flight-${trackedId} input[type="number"]').focus()`);
  await fill(`#tracked-flight-${trackedId} input[type="number"]`, '10000');
  assert.equal(await evaluate(`document.querySelector('#tracked-flight-${trackedId} input[type="number"]').value`), '10000');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await until(async () => (await TrackedFlight.findById(trackedId).lean()).targetPrice === 10000, 'target persisted');
  await until(() => evaluate(`!document.querySelector('#tracked-flight-${trackedId} button')?.disabled`), 'target update rendered');
  await until(() => evaluate(`(()=>{const button=Array.from(document.querySelectorAll('#tracked-flight-${trackedId} button')).find(b=>b.textContent==='Check fare');if(!button||button.disabled)return false;button.click();return true})()`), 'manual check button ready');
  await until(() => evaluate(`window.__qaRequests.some(r=>r.path==='/api/tracked-flights/${trackedId}/refresh'&&r.status===202)`), 'manual check queued');
  assert.equal((await TrackedFlight.findById(trackedId).lean()).currentPrice, 10500);
  evidence.checks.manualCheckAndTarget = true;
  await until(() => evaluate(`Boolean(Array.from(document.querySelectorAll('#tracked-flight-${trackedId} button')).find(b=>b.textContent==='Pause'&&!b.disabled))`), 'manual check reload completed');
  await evaluate(`Array.from(document.querySelectorAll('#tracked-flight-${trackedId} button')).find(b=>b.textContent==='Pause').click()`);
  await until(async () => (await TrackedFlight.findById(trackedId).lean()).status === 'paused', 'pause persisted'); evidence.checks.editTracking = true;
  await until(() => evaluate(`Boolean(Array.from(document.querySelectorAll('#tracked-flight-${trackedId} button')).find(b=>b.textContent==='Resume'))`), 'pause rendered after dashboard reload');
  await evaluate(`setTimeout(()=>document.querySelector('#tracked-flight-${trackedId} button[aria-label="Remove tracked flight"]').click(),0)`); await pause(150); await call('Page.handleJavaScriptDialog', { accept: true });
  await until(async () => !await TrackedFlight.exists({ _id: trackedId }), 'tracking removal'); evidence.checks.removeTracking = true;
  await AuthSession.updateMany({ userId: accounts[0].id }, { $set: { expiresAt: new Date(0) } });
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Sign out')).click()`);
  await until(() => evaluate(`location.pathname==='/login'`), 'expired session logout');
  evidence.checks.expiredSessionLogout = true;
  evidence.runtimeErrors = browser.errors; assert.deepEqual(browser.errors, []);
} catch (error) {
  evidence.failure = error.message; evidence.runtimeErrors = browser?.errors || [];
  if (browser) evidence.diagnostics = await browser.evaluate(`({failedRequests:(window.__qaRequests||[]).filter(r=>r.status>=400).map(r=>({path:r.path,status:r.status})),targetInput:document.querySelector('#tracked-flight-${trackedId} input[type="number"]')?.value})`).catch(() => ({}));
  console.error(error.message); process.exitCode = 1;
}
finally {
  await browser?.close();
  for (const account of accounts) {
    const id = account.id || (await User.findOne({ email: account.email }).lean())?._id;
    if (id) { for (const Model of [PriceObservation, Notification, DisruptionPrediction, FareIntelligenceAnalysis, IntelligenceReport, TrackedFlight, AuthSession]) await Model.deleteMany({ userId: id }); await User.deleteOne({ _id: id }); await ProviderState.deleteMany({ key: { $regex: `^fare-market:${id}:` } }); }
  }
  await ProviderState.deleteMany({ key: { $in: refs.map(ref => `track:${ref}`) } });
  await closeDatabase(); await mkdir(output, { recursive: true }); await writeFile(`${output}/dashboard-navigation.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
}
