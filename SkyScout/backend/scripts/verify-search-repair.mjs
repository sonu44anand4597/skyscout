// Actual browser/API tests first. Isolated browser fixtures are labeled separately.
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
const output = '../docs/qa/search-repair-2026-10-30';
const evidence = { executedAt: new Date().toISOString(), live: {}, controlledFixtures: {}, checks: {} };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const email = `search-qa-${randomUUID()}@example.test`; const password = randomUUID();
let browser; let userId; let ref;
try {
  await connectDB(); await mkdir(output, { recursive: true }); browser = await browserSession(9236);
  const { call, evaluate, fill } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original = window.fetch.bind(window); window.__qaRequests = [];
    window.fetch = async (...args) => {
      const response = await original(...args); const url = new URL(String(args[0]), location.href);
      if (url.pathname.startsWith('/api/')) {
        const entry = { path: url.pathname, query: Object.fromEntries(url.searchParams), status: response.status }; window.__qaRequests.push(entry);
        response.clone().json().then(body => { entry.summary = { code: body.code, message: body.message, source: body.airportSearch?.source, providerStatus: body.airportSearch?.providerStatus, airports: body.airportSearch ? body.data?.map(a => a.iata) : undefined, flights: url.pathname === '/api/flights/search' ? body.data?.map(f => ({from:f.from,to:f.to,price:f.price,currency:f.currency})) : undefined }; entry.done = true; }).catch(() => { entry.done = true; });
      } return response;
    };
  })();` });
  async function home() {
    const url=`${web}/?browserQa=${randomUUID()}#flight-search`;
    await call('Page.navigate', { url });
    await until(() => evaluate(`location.href===${JSON.stringify(url)} && document.querySelectorAll('#flight-search input[role="combobox"]').length === 2`), 'fresh search page');
  }
  async function input(index, text) {
    const id = await evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[${index}].id`);
    const selector = `[id=${JSON.stringify(id)}]`;
    await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`); await fill(selector, text);
  }
  async function options(query, code) {
    await until(() => evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(a => a.innerText.includes(${JSON.stringify(code)}))`), `airport ${query} ${code}`);
  }
  async function choose(index, query, code, keyboard = false) {
    await input(index, query); await options(query, code);
    if (keyboard) {
      const optionIndex = await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).findIndex(a=>a.innerText.includes(${JSON.stringify(code)}))`);
      for (let n=0;n<=optionIndex;n++) await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    } else {
      const rect = await evaluate(`(() => { const option = Array.from(document.querySelectorAll('[role="option"]')).find(a => a.innerText.includes(${JSON.stringify(code)})); option.scrollIntoView({block:'center'}); const r=option.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
    }
    await until(()=>evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[${index}].value.endsWith(${JSON.stringify(`(${code})`)})`),`selected ${code}`);
  }
  const click = (text) => evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  async function submit(expected) {
    await click('Search flights');
    await until(() => evaluate(`location.pathname === '/results'`), 'results navigation');
    await until(() => evaluate(`window.__qaRequests.some(r=>r.path==='/api/flights/search'&&r.done)`), 'actual flight endpoint result');
    const request = await evaluate(`window.__qaRequests.filter(r=>r.path==='/api/flights/search').at(-1)`);
    for (const [key, value] of Object.entries(expected)) assert.equal(request.query[key], String(value), key);
    if (request.status === 200 && request.summary.flights?.length) {
      await until(() => evaluate(`Boolean(document.querySelector('article'))`), 'genuine provider results');
      request.outcome = 'live_provider_offers_rendered';
    } else {
      request.outcome = request.status === 200 ? 'provider_returned_no_offers' : 'live_provider_blocked';
      await until(()=>evaluate(request.status === 200 ? `document.body.innerText.includes('No flights found for the selected route and dates.')` : `Boolean(document.querySelector('[role="alert"]'))`),'precise flight error or empty state');
    }
    return request;
  }
  const shot = async (name) => { const r = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(`${output}/${name}.png`, Buffer.from(r.data, 'base64')); };

  console.log('Browser QA: real airport catalog and primary-provider failure handling');
  await home(); evidence.live.autocomplete = [];
  for (const [query, code] of [['mumbai','BOM'],['Mumbai','BOM'],['mum','BOM'],['BOM','BOM'],['Bombay','BOM'],['Delhi','DEL'],['Bangalore','BLR'],['Bengaluru','BLR'],['Hyderabad','HYD'],['Chennai','MAA'],['Kolkata','CCU'],['Pune','PNQ'],['Dubai','DXB']]) {
    console.log(`  Checking ${query} -> ${code}`);
    await input(0, query); await options(query, code); evidence.live.autocomplete.push({ query, code, matched: true });
  }
  await input(0, 'London'); await options('London','LHR');
  const london = await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).map(a=>a.innerText)`);
  for (const code of ['LHR','LGW','STN','LTN','LCY','SEN']) assert.ok(london.some(value=>value.includes(code)));
  evidence.live.londonIndividualAirports = ['LHR','LGW','STN','LTN','LCY','SEN'];
  await input(0, 'mumbai'); await options('mumbai','BOM');
  assert.equal(await evaluate(`document.body.innerText.includes('No airport found.')`), false);
  await evaluate(`document.querySelector('#flight-search input').scrollIntoView({block:'center'})`); await shot('mumbai-desktop');
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }); await pause(200);
  evidence.checks.mobile360SearchNoOverflow = await evaluate(`Array.from(document.querySelector('#flight-search').querySelectorAll('input,button,[role="listbox"]')).every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`);
  evidence.checks.mobile360DropdownWidth = await evaluate(`document.querySelector('[role="listbox"]').getBoundingClientRect().width`);
  await shot('mumbai-mobile'); assert.equal(evidence.checks.mobile360SearchNoOverflow, true); assert.ok(evidence.checks.mobile360DropdownWidth >= 240);
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await choose(0,'mumbai','BOM',true); await choose(1,'delhi','DEL');
  await fill('#flight-search input[type="date"]', day(28));
  evidence.live.oneWay = await submit({ origin:'BOM',destination:'DEL',tripType:'one-way',adults:1,travelClass:1 });
  await shot('one-way-result');

  console.log('Browser QA: selections, swap, round-trip and multi-city API parameters');
  await home(); await choose(0,'Bengaluru','BLR'); await choose(1,'Mumbai','BOM'); evidence.checks.bengaluruToMumbai = true;
  await evaluate(`document.querySelector('button[aria-label="Swap origin and destination"]').click()`);
  const swapped = await evaluate(`Array.from(document.querySelectorAll('#flight-search input[role="combobox"]')).map(i=>i.value)`);
  assert.ok(swapped[0].includes('(BOM)') && swapped[1].includes('(BLR)'));
  await fill('#flight-search input[type="date"]', day(29)); evidence.live.swappedSearch = await submit({origin:'BOM',destination:'BLR'});
  await home(); await choose(0,'Mumbai','BOM'); await choose(1,'Delhi','DEL');
  await input(0,'Mumbai edited'); await click('Search flights');
  assert.equal(await evaluate('location.pathname'), '/'); assert.match(await evaluate(`document.querySelector('#flight-search [role="alert"]').innerText`), /suggestions/);
  evidence.checks.editedSelectionInvalidated = true;
  await choose(0,'Mumbai','BOM'); await choose(1,'Bombay','BOM'); await click('Search flights');
  assert.match(await evaluate(`document.querySelector('#flight-search [role="alert"]').innerText`), /same/); evidence.checks.identicalAirportsRejected = true;
  await choose(1,'Delhi','DEL'); await evaluate(`document.querySelector('input[value="round-trip"]').click()`);
  const dates = await evaluate(`Array.from(document.querySelectorAll('#flight-search input[type="date"]')).map(i=>i.id)`);
  await fill(`[id=${JSON.stringify(dates[0])}]`,day(28)); await fill(`[id=${JSON.stringify(dates[1])}]`,day(32));
  await evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.includes('traveller')).click()`);
  for (const label of ['Add adults','Add children','Add infants']) await evaluate(`document.querySelector('button[aria-label="${label}"]').click()`);
  await click('Done'); await evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.includes('Economy')).click()`); await click('Business');
  evidence.live.roundTrip = await submit({origin:'BOM',destination:'DEL',tripType:'round-trip',returnDate:day(32),adults:2,children:1,infants:1,travelClass:3});
  await home(); await evaluate(`document.querySelector('input[value="multi-city"]').click()`);
  await choose(0,'Mumbai','BOM'); await choose(1,'Delhi','DEL'); await choose(2,'Delhi','DEL'); await choose(3,'Bengaluru','BLR');
  const legDates=await evaluate(`Array.from(document.querySelectorAll('#flight-search input[type="date"]')).map(i=>i.id)`);
  await fill(`[id=${JSON.stringify(legDates[0])}]`,day(28)); await fill(`[id=${JSON.stringify(legDates[1])}]`,day(30));
  evidence.live.multiCity = await submit({origin:'BOM',destination:'BLR',tripType:'multi-city'});
  assert.deepEqual(JSON.parse(evidence.live.multiCity.query.legs),[{from:'BOM',to:'DEL',date:day(28)},{from:'DEL',to:'BLR',date:day(30)}]);

  console.log('Browser QA: isolated race/error/empty-response fixtures, not provider results');
  await home();
  await evaluate(`(() => { const original=window.fetch; window.__fixtureMode='race'; window.fetch=async (url,options)=>{
    if(!String(url).includes('/flights/airports')) return original(url,options);
    const query=new URL(url).searchParams.get('q');
    if(window.__fixtureMode==='error') return new Response(JSON.stringify({message:'Controlled airport endpoint outage'}),{status:503});
    const data=window.__fixtureMode==='empty'?[]:[query==='mumbai'?{iata:'BOM',code:'BOM',city:'Mumbai',airport:'Controlled race fixture'}:{iata:'DEL',code:'DEL',city:'Delhi',airport:'Controlled race fixture'}];
    await new Promise(resolve=>setTimeout(resolve,query==='mumbai'?1400:80));
    return new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json'}});
  }; })()`);
  await input(0,'mumbai'); await pause(450); await input(0,'delhi'); await options('delhi','DEL'); await pause(1500);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(a=>a.innerText.includes('BOM'))`),false); evidence.controlledFixtures.lateResponseIgnored = true;
  await input(0,''); await pause(100); assert.equal(await evaluate(`document.querySelectorAll('[role="option"]').length`),0);
  await evaluate(`window.__fixtureMode='error'`); await input(0,'outage');
  await until(()=>evaluate(`document.body.innerText.includes('Controlled airport endpoint outage')`),'explicit endpoint outage');
  assert.equal(await evaluate(`document.body.innerText.includes('No matching airports found.')`),false); evidence.controlledFixtures.errorNotFalseZero = true;
  await evaluate(`window.__fixtureMode='empty'`); await input(0,'unknown');
  await until(()=>evaluate(`document.body.innerText.includes('No matching airports found.')`),'real empty result distinction');
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  assert.deepEqual(browser.errors,[]); evidence.controlledFixtures.emptyKeyboardSafe = true;

  console.log('Browser QA: controlled continuation fixtures for both journey directions and city legs');
  const outbound={id:'qa-outbound',from:'BOM',to:'DEL',fromName:'Mumbai',toName:'Delhi',airline:'QA controlled fixture',flightNumber:'QA 101',departure:'09:00',arrival:'11:00',departureAt:`${day(28)} 09:00`,arrivalAt:`${day(28)} 11:00`,durationMinutes:120,stops:0,stopsLabel:'Non-stop',price:12000,currency:'INR',travelClass:'Economy',departureRef:'controlled-departure'};
  async function controlledContinuation(tripType) {
    await home(); await evaluate(`document.querySelector('input[value="${tripType}"]').click()`);
    await choose(0,'Mumbai','BOM'); await choose(1,'Delhi','DEL');
    if(tripType==='multi-city'){await choose(2,'Delhi','DEL');await choose(3,'Bengaluru','BLR');}
    const dateIds=await evaluate(`Array.from(document.querySelectorAll('#flight-search input[type="date"]')).map(i=>i.id)`);
    await fill(`[id=${JSON.stringify(dateIds[0])}]`,day(28));await fill(`[id=${JSON.stringify(dateIds[1])}]`,day(32));
    const inbound={...outbound,id:'qa-next',from:'DEL',to:tripType==='multi-city'?'BLR':'BOM',flightNumber:'QA 102',departureAt:`${day(32)} 09:00`,arrivalAt:`${day(32)} 11:00`};
    const legs=tripType==='multi-city'?[{...outbound,legNumber:1},{...inbound,legNumber:2}]:[{...outbound,direction:'Outbound'},{...inbound,direction:'Return'}];
    const complete={...outbound,id:'qa-complete',to:tripType==='multi-city'?'BLR':'DEL',price:25000,bookingRef:'controlled-booking',departureRef:null,...(tripType==='multi-city'?{journeyLegs:legs,multiCityComplete:true}:{roundTripLegs:legs})};
    await evaluate(`(()=>{const original=window.fetch;window.fetch=(url,options)=>{
      const path=new URL(url).pathname;
      const data=path==='/api/flights/search'?${JSON.stringify([outbound])}:path.includes('/return-options/')?${JSON.stringify([complete])}:path.includes('/booking-options/')?[{provider:'QA booking fixture',price:25000,currency:'INR',bookingUrl:'https://www.google.com/travel/clk'}]:null;
      return data?Promise.resolve(new Response(JSON.stringify({success:true,data}),{headers:{'Content-Type':'application/json'}})):original(url,options);
    };})()`);
    await click('Search flights');await until(()=>evaluate(`Boolean(document.querySelector('article'))`),'controlled outbound card');
    const label=tripType==='multi-city'?'Choose city leg 1':'Choose outbound';
    await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    await until(()=>evaluate(`Boolean(Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Track this flight'))`),'complete journey card');
    const card=await evaluate(`document.querySelector('article').innerText`);
    for(const text of [tripType==='multi-city'?'CITY LEG 1':'OUTBOUND',tripType==='multi-city'?'CITY LEG 2':'RETURN','BOM','DEL',tripType==='multi-city'?'BLR':'BOM','25,000'])assert.ok(card.includes(text),text);
    await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Booking options').click()`);
    await until(()=>evaluate(`Boolean(document.querySelector('article a[target="_blank"]'))`),'booking handoff');
    assert.equal(await evaluate(`document.querySelector('article a[target="_blank"]').href`),'https://www.google.com/travel/clk');
    await shot(`controlled-${tripType}`);evidence.controlledFixtures[tripType]={bothLegsDisplayed:true,finalTicketTotal:25000,bookingHandoffRendered:true,source:'Isolated browser response fixtures; not live provider offers'};
  }
  await controlledContinuation('round-trip');await controlledContinuation('multi-city');

  console.log('Browser QA: labeled synthetic offer; real session, tracking database and dashboard');
  await call('Page.navigate',{url:`${web}/register`}); await until(()=>evaluate(`Boolean(document.querySelector('input[autocomplete="name"]'))`),'register form');
  await fill('input[autocomplete="name"]','Search repair QA'); await fill('input[type="email"]',email); await fill('input[type="password"]',password);
  await evaluate(`document.querySelector('form button').click()`); await until(()=>evaluate(`location.pathname==='/dashboard'`),'registration');
  userId=(await User.findOne({email}).lean())._id;
  ref=randomUUID();
  const departureAt=`${day(28)} 09:00`; const arrivalAt=`${day(28)} 11:00`;
  const fixture={...outbound,id:'controlled-qa-flight',departureRef:null,flightNumber:'QA 100',departureAt,arrivalAt,price:12345,trackRef:ref,quoteObservedAt:new Date().toISOString(),segments:[{airline:'QA controlled fixture',flightNumber:'QA 100',origin:{code:'BOM',time:departureAt},destination:{code:'DEL',time:arrivalAt},durationMinutes:120}]};
  await ProviderState.create({key:`track:${ref}`,payload:{flight:fixture,context:{tripType:'one-way',departureDate:day(28),adults:1,children:0,infants:0,travelClass:1,quoteObservedAt:fixture.quoteObservedAt},expiresAt:Date.now()+600000},expiresAt:new Date(Date.now()+600000)});
  await home(); await choose(0,'Mumbai','BOM'); await choose(1,'Delhi','DEL'); await fill('#flight-search input[type="date"]',day(28));
  await evaluate(`(() => {const original=window.fetch;window.fetch=(url,options)=>String(url).includes('/flights/search?')?Promise.resolve(new Response(JSON.stringify({success:true,data:${JSON.stringify([fixture])},searchedAt:${JSON.stringify(fixture.quoteObservedAt)}}),{headers:{'Content-Type':'application/json'}})):original(url,options);})()`);
  await click('Search flights'); await until(()=>evaluate(`document.body.innerText.includes('QA controlled fixture')`),'controlled result rendered');
  await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Track this flight').click()`);
  await until(async()=>Boolean(await TrackedFlight.exists({userId})),'real tracking persisted');
  const tracked=await TrackedFlight.findOne({userId}).lean(); assert.equal(tracked.origin,'BOM'); assert.equal(tracked.destination,'DEL'); assert.equal(tracked.currentPrice,12345);
  await call('Page.navigate',{url:`${web}/dashboard?flight=${tracked._id}`});
  await until(()=>evaluate(`Boolean(document.querySelector('#tracked-flight-${tracked._id}')) && document.body.innerText.includes('QA controlled fixture')`),'correct dashboard itinerary');
  await until(()=>evaluate(`Boolean(document.querySelector('section[aria-label="Fare Intelligence"]')) && document.body.innerText.includes('Notifications')`),'existing dashboard panels');
  await call('Page.reload'); await until(()=>evaluate(`Boolean(document.querySelector('#tracked-flight-${tracked._id}'))`),'persisted dashboard reload');
  evidence.controlledFixtures.realSessionTrackingDashboard = {source:'Synthetic labeled offer, real HTTP tracking and MongoDB',origin:tracked.origin,destination:tracked.destination,observations:await PriceObservation.countDocuments({trackedFlightId:tracked._id}),refreshPersisted:true};
  evidence.runtimeErrors=browser.errors; assert.deepEqual(browser.errors,[]);
  console.log(JSON.stringify(evidence));
} catch(error) {evidence.failure=error.stack||error.message;evidence.runtimeErrors=browser?.errors||[];console.error(evidence.failure);process.exitCode=1;}
finally{
  await browser?.close(); userId ||= (await User.findOne({email}).lean())?._id;
  if(userId){for(const Model of [PriceObservation,Notification,DisruptionPrediction,FareIntelligenceAnalysis,IntelligenceReport,TrackedFlight,AuthSession])await Model.deleteMany({userId});await User.deleteOne({_id:userId});await ProviderState.deleteMany({key:{$regex:`^fare-market:${userId}:`}});}
  if(ref)await ProviderState.deleteOne({key:`track:${ref}`});
  await closeDatabase();await mkdir(output,{recursive:true});await writeFile(`${output}/verification.json`,JSON.stringify(evidence,null,2));
}
