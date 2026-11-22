// Synthetic, explicitly labeled schedule/fare; real calendar, Gemini, weather,
// installed ML and destination services. Never treat this as live fare evidence.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import connectDB, { closeDatabase } from '../config/database.js';
import { browserSession, until } from './browser-session.mjs';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import DisruptionPrediction from '../models/DisruptionPrediction.js';
import Notification from '../models/Notification.js';
import FareIntelligenceAnalysis from '../models/FareIntelligenceAnalysis.js';
import IntelligenceReport from '../models/IntelligenceReport.js';
import ProviderState from '../models/ProviderState.js';

const web = process.env.E2E_WEB_URL || 'http://127.0.0.1:5173';
const output = process.env.QA_OUTPUT_DIR || '../docs/qa/final-production-2026-11-03/intelligence';
const email = `intelligence-browser-${randomUUID()}@example.test`;
const evidence = { executedAt: new Date().toISOString(), source: 'Explicit QA schedule/fare; actual official calendar, ML artifact, weather and configured research services. Market-offer refresh disabled only inside this browser.' };
let browser; let userId;
try {
  await mkdir(output, { recursive: true }); await connectDB();
  browser = await browserSession(9236);
  const { call, evaluate, fill } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original=window.fetch.bind(window);window.__intelligenceRequests=[];
    window.fetch=async(...args)=>{
      const url=new URL(String(args[0]),location.href);
      if(url.pathname.endsWith('/fare-intelligence/market'))return new Response(JSON.stringify({success:true,market:{status:'qa_disabled',offers:[]}}));
      const r=await original(...args);
      if(url.pathname.startsWith('/api/')){const entry={path:url.pathname,query:url.search,status:r.status};window.__intelligenceRequests.push(entry);r.clone().json().then(b=>{entry.body=b;entry.done=true}).catch(()=>entry.done=true)}return r;
    };
  })();` });
  await call('Page.navigate', { url: `${web}/register` });
  await until(() => evaluate(`Boolean(document.querySelector('input[autocomplete="name"]'))`), 'registration');
  await fill('input[autocomplete="name"]', 'Explicit intelligence QA fixture');
  await fill('input[type="email"]', email); await fill('input[type="password"]', randomUUID());
  await evaluate(`document.querySelector('form button').click()`);
  await until(() => evaluate(`location.pathname==='/dashboard'`), 'signed-in Dashboard');
  userId = (await User.findOne({ email }).lean())._id;
  const date = '2026-11-26';
  assert.ok(date > new Date().toISOString().slice(0, 10), 'Choose a future officially covered holiday before rerunning this dated release check');
  const observedAt = new Date();
  const flight = await TrackedFlight.create({ userId, fingerprint: randomUUID(), origin: 'JFK', destination: 'LAX', departureDate: date,
    departureAt: `${date}T09:00:00-05:00`, airline: 'American Airlines', flightNumber: 'AA 100', tripType: 'one-way',
    segments: [{ durationMinutes: 360 }], initialPrice: 150, currentPrice: 150, quoteObservedAt: observedAt, currency: 'USD', status: 'paused' });
  await PriceObservation.create({ userId, trackedFlightId: flight._id, price: 150, currency: 'USD', observedAt, quoteKey: `qa-${randomUUID()}` });
  await call('Page.navigate', { url: `${web}/dashboard?flight=${flight._id}` });
  const response = suffix => evaluate(`window.__intelligenceRequests.filter(r=>r.path.endsWith(${JSON.stringify(suffix)})&&r.done).at(-1)`);
  await until(async () => Boolean(await response('/fare-intelligence')), 'Fare Intelligence');
  const fare = await response('/fare-intelligence');
  const holiday = fare.body.calendarContext.events.find(event => event.title === 'Thanksgiving Day');
  assert.ok(holiday?.sourceUrl.includes('opm.gov'));
  await until(() => evaluate(`document.querySelector('[aria-label="Fare Intelligence"]').innerText.includes('Thanksgiving Day')`), 'official calendar in UI');
  evidence.calendar = { status: fare.body.calendarContext.status, event: holiday, rendered: true };
  await until(async () => Boolean(await response('/weather')) && Boolean(await response('/prediction')), 'actual ML/weather');
  const weather = await response('/weather'); const model = await response('/prediction');
  assert.equal(weather.body.available, true); assert.equal(model.body.available, true);
  await until(() => evaluate(`document.querySelector('[aria-label="Airport weather"]').innerText.includes('METAR')&&document.body.innerText.includes('delay-lstm-v2')`), 'weather and model in UI');
  evidence.weather = { rendered: true, airports: weather.body.airports.map(a => ({ airport: a.airport, observedAt: a.observation?.observedAt, metarFetchedAt: a.metarFetchedAt, tafFetchedAt: a.tafFetchedAt, metarStale: a.metarStale, tafStale: a.tafStale })) };
  evidence.model = { rendered: true, version: model.body.prediction.modelVersion, probability: model.body.prediction.probability, scheduleSource: 'QA fixture, not a current flight quote' };
  await until(async () => Boolean(await response('/fare-intelligence/research')), 'actual automatic Gemini attempt', 300);
  const research = (await response('/fare-intelligence/research')).body.eventIntelligence;
  evidence.research = { status: research.status, events: research.events?.length || 0, checkedAt: research.checkedAt,
    storageAuthorized: research.storageAuthorized, sources: research.events?.map(e => ({ title: e.title, url: e.sourceUrl })) || [] };
  if (research.events?.length) {
    await until(() => evaluate(`Array.from(document.querySelectorAll('[aria-label="Fare Intelligence"] a')).some(a=>a.getAttribute('href')===${JSON.stringify(research.events[0].sourceUrl)})`), 'live source link');
    evidence.research.citationsRendered = true;
  }
  await until(() => evaluate(`!document.querySelector('[aria-label="Destination intelligence"] button').disabled`), 'initial city briefing');
  await fill(`#final-destination-${flight._id}`, 'Santa Monica Pier, Los Angeles');
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="Destination intelligence"] button')).find(b=>b.textContent==='Check journey').click()`);
  await until(() => evaluate(`window.__intelligenceRequests.some(r=>r.path.endsWith('/destination-intelligence')&&r.query.includes('finalDestination=')&&r.done)`), 'actual journey response', 300);
  const destination = await evaluate(`window.__intelligenceRequests.filter(r=>r.path.endsWith('/destination-intelligence')&&r.query.includes('finalDestination=')&&r.done).at(-1).body`);
  evidence.destination = { cityAvailable: destination.available, cityEvents: destination.events?.length || 0, routing: destination.journey?.routing,
    researchStatus: destination.journey?.research?.status, geometryStatus: destination.journey?.research?.geometryStatus };
  if (destination.journey?.routing?.status === 'not_configured') {
    await until(() => evaluate(`document.querySelector('[aria-label="Destination intelligence"]').innerText.includes(${JSON.stringify(destination.journey.routing.message)})`), 'missing routing configuration in UI');
    evidence.destination.missingConfigurationRendered = true;
  }
  const shot = async name => { const image = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(`${output}/${name}.png`, Buffer.from(image.data, 'base64')); };
  await evaluate(`document.querySelector('[aria-label="Fare Intelligence"]').scrollIntoView({block:'start'})`); await shot('calendar-research');
  await evaluate(`document.querySelector('[aria-label="Destination intelligence"]').scrollIntoView({block:'start'})`); await shot('destination-partial');
  evidence.runtimeErrors = browser.errors; assert.deepEqual(browser.errors, []);
} catch (error) { evidence.failure = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  await browser?.close(); userId ||= (await User.findOne({ email }).lean())?._id;
  if (userId) { for (const Model of [PriceObservation, Notification, DisruptionPrediction, FareIntelligenceAnalysis, IntelligenceReport, TrackedFlight, AuthSession]) await Model.deleteMany({ userId }); await User.deleteOne({ _id: userId }); await ProviderState.deleteMany({ key: { $regex: `^fare-market:${userId}:` } }); }
  await closeDatabase(); await mkdir(output, { recursive: true });
  await writeFile(`${output}/intelligence-browser.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
}
