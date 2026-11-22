// Bounded real-provider/browser checks. No intercepted or synthetic flight offers.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import connectDB, { closeDatabase } from '../config/database.js';
import { browserSession, until, pause } from './browser-session.mjs';
import { processFlight } from '../services/monitoringWorker.js';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import TrackedFlight from '../models/TrackedFlight.js';
import PriceObservation from '../models/PriceObservation.js';
import Notification from '../models/Notification.js';
import DisruptionPrediction from '../models/DisruptionPrediction.js';
import FareIntelligenceAnalysis from '../models/FareIntelligenceAnalysis.js';
import IntelligenceReport from '../models/IntelligenceReport.js';
import ProviderState from '../models/ProviderState.js';

const web = process.env.E2E_WEB_URL || 'http://127.0.0.1:5173';
const api = process.env.E2E_API_URL || 'http://127.0.0.1:5000/api';
const output = process.env.QA_OUTPUT_DIR || '../docs/qa/provider-restore-2026-10-31';
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const email = `provider-restore-${randomUUID()}@example.test`;
const password = randomUUID();
const evidence = { executedAt: new Date().toISOString(), source: 'Real Chrome → Express → SerpApi → MongoDB; no flight response fixtures', autocomplete: [], searches: [] };
let browser; let userId; let existing; let existingIds;
async function savedHistory() {
  // Protect the records present at the start. Other isolated QA accounts may
  // legitimately add observations while this browser runs.
  const records = await PriceObservation.find(existingIds ? { _id: { $in: existingIds } } : {}).sort({ _id: 1 }).lean();
  existingIds ||= records.map(record => record._id);
  return { count: records.length, sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}
try {
  await mkdir(output, { recursive: true }); await connectDB(); existing = await savedHistory();
  browser = await browserSession(9237); const { call, evaluate, fill } = browser;
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original=window.fetch.bind(window);window.__qaRequests=[];
    window.fetch=async(...args)=>{
      const response=await original(...args);const url=new URL(String(args[0]),location.href);
      if(url.pathname.startsWith('/api/')){
        const entry={path:url.pathname,query:Object.fromEntries(url.searchParams),status:response.status};window.__qaRequests.push(entry);
        response.clone().json().then(body=>{entry.body=body;entry.done=true}).catch(()=>entry.done=true);
      }return response;
    };
  })();` });
  const shot = async name => { const r = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(`${output}/${name}.png`, Buffer.from(r.data, 'base64')); };
  async function home() {
    const url=`${web}/?liveQa=${randomUUID()}#flight-search`;await call('Page.navigate',{url});
    await until(()=>evaluate(`location.href===${JSON.stringify(url)}&&document.querySelectorAll('#flight-search input[role="combobox"]').length===2`),'fresh home');
  }
  async function input(index,text) {
    const id=await evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[${index}].id`);
    await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);await fill(`[id=${JSON.stringify(id)}]`,text);
  }
  async function choose(index,text,code,keyboard=false) {
    await input(index,text);await until(()=>evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(a=>a.innerText.includes(${JSON.stringify(code)}))`),`airport ${text}`);
    if(keyboard){
      const i=await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).findIndex(a=>a.innerText.includes(${JSON.stringify(code)}))`);
      for(let n=0;n<=i;n++)await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    }else{
      const r=await evaluate(`(()=>{const a=Array.from(document.querySelectorAll('[role="option"]')).find(a=>a.innerText.includes(${JSON.stringify(code)}));a.scrollIntoView({block:'center'});const r=a.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await call('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...r,button:'left',clickCount:1});
    }
    await until(()=>evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[${index}].value.endsWith(${JSON.stringify(`(${code})`)})`),`selected ${code}`);
  }
  const button = text => evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  async function dates(values) {
    const ids=await evaluate(`Array.from(document.querySelectorAll('#flight-search input[type="date"]')).map(i=>i.id)`);
    for(let i=0;i<values.length;i++)await fill(`[id=${JSON.stringify(ids[i])}]`,values[i]);
  }
  async function submit(expected) {
    await button('Search flights');await until(()=>evaluate(`window.__qaRequests.some(r=>r.path==='/api/flights/search'&&r.done)`),'live search response');
    const result=await evaluate(`window.__qaRequests.filter(r=>r.path==='/api/flights/search').at(-1)`);
    assert.equal(result.status,200,result.body.message);assert.ok(result.body.data.length,'genuine provider offers required');
    for(const [key,value]of Object.entries(expected))assert.equal(result.query[key],String(value),key);
    await until(()=>evaluate(`Boolean(document.querySelector('article'))`),'real result cards');
    return result;
  }
  const summary = result => ({ query:result.query,status:result.status,offers:result.body.data.length,cached:result.body.cached,searchedAt:result.body.searchedAt,rendered:true,sample:result.body.data.slice(0,3).map(f=>({from:f.from,to:f.to,airline:f.airline,flightNumber:f.flightNumber,departureAt:f.departureAt,arrivalAt:f.arrivalAt,price:f.price,currency:f.currency,stops:f.stops,durationMinutes:f.durationMinutes})) });
  async function signedRequest(path) {
    return evaluate(`(async()=>{const r=await fetch(${JSON.stringify(api)}+${JSON.stringify(path)},{credentials:'include'});return{status:r.status,body:await r.json()}})()`);
  }

  console.log('Live browser: isolated real registration and catalog autocomplete');
  await call('Page.navigate',{url:`${web}/register`});await until(()=>evaluate(`Boolean(document.querySelector('input[autocomplete="name"]'))`),'registration');
  await fill('input[autocomplete="name"]','Live provider QA');await fill('input[type="email"]',email);await fill('input[type="password"]',password);
  await evaluate(`document.querySelector('form button').click()`);await until(()=>evaluate(`location.pathname==='/dashboard'`),'authenticated dashboard');
  userId=(await User.findOne({email}).lean())._id;
  await home();
  for(const [query,code]of [['mumbai','BOM'],['Bombay','BOM'],['Delhi','DEL'],['Bangalore','BLR'],['Bengaluru','BLR'],['Hyderabad','HYD'],['Chennai','MAA'],['Dubai','DXB']]){
    await input(0,query);await until(()=>evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(a=>a.innerText.includes(${JSON.stringify(code)}))`),query);
    evidence.autocomplete.push({query,code,matched:true});
  }
  const airportRequests=await evaluate(`window.__qaRequests.filter(r=>r.path==='/api/flights/airports'&&r.done).map(r=>({query:r.query.q,status:r.status,source:r.body.airportSearch?.source,providerStatus:r.body.airportSearch?.providerStatus}))`);
  assert.ok(airportRequests.every(r=>r.status===200&&r.source==='catalog'&&r.providerStatus==='not_requested'));evidence.autocompleteRequests=airportRequests;
  for(const [origin,destination,from,to,swap]of [['BOM','DEL','Mumbai','Delhi',false],['BLR','BOM','Bengaluru','Mumbai',false],['DEL','BLR','Bengaluru','Delhi',true]]){
    console.log(`Live browser search: ${origin} -> ${destination}`);
    await home();await choose(0,from,swap?'BLR':origin,true);await choose(1,to,swap?'DEL':destination);
    if(swap)await evaluate(`document.querySelector('[aria-label="Swap origin and destination"]').click()`);
    await dates([day(28)]);const result=await submit({origin,destination,date:day(28),tripType:'one-way',adults:1,travelClass:1});
    assert.ok(result.body.data.every(f=>f.from===origin&&f.to===destination&&f.departureAt.startsWith(day(28))&&f.price>0&&f.currency==='INR'));
    const first=result.body.data[0];assert.ok(first.airline&&first.departureAt&&first.arrivalAt&&Number.isFinite(first.durationMinutes));
    evidence.searches.push(summary(result));await shot(`${origin.toLowerCase()}-${destination.toLowerCase()}-live`);
  }

  for(const tripType of ['round-trip','multi-city']){
    console.log(`Live browser continuation: ${tripType}`);
    await home();await evaluate(`document.querySelector('input[value="${tripType}"]').click()`);await choose(0,'Mumbai','BOM');await choose(1,'Delhi','DEL');
    if(tripType==='multi-city'){await choose(2,'Delhi','DEL');await choose(3,'Bengaluru','BLR');}
    await dates([day(28),day(32)]);
    if(tripType==='round-trip'){
      await evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.includes('traveller')).click()`);
      for(const label of ['Add adults','Add children','Add infants'])await evaluate(`document.querySelector('[aria-label="${label}"]').click()`);
      await button('Done');await evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.includes('Economy')).click()`);await button('Business');
    }
    const result=await submit({origin:'BOM',destination:tripType==='multi-city'?'BLR':'DEL',tripType,...(tripType==='round-trip'?{returnDate:day(32),adults:2,children:1,infants:1,travelClass:3}:{})});
    const label=tripType==='multi-city'?'Choose city leg 1':'Choose outbound';
    await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled).click()`);
    await until(()=>evaluate(`window.__qaRequests.some(r=>r.path.includes('/return-options/')&&r.done)`),'real provider continuation');
    const next=await evaluate(`window.__qaRequests.filter(r=>r.path.includes('/return-options/')).at(-1)`);assert.equal(next.status,200,next.body.message);assert.ok(next.body.data.length);
    const complete=next.body.data[0];const legs=tripType==='multi-city'?complete.journeyLegs:complete.roundTripLegs;
    assert.deepEqual(legs.map(l=>[l.from,l.to]),[['BOM','DEL'],['DEL',tripType==='multi-city'?'BLR':'BOM']]);assert.ok(complete.price>0);
    await until(()=>evaluate(`Boolean(Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Track this flight'))`),'complete itinerary rendering');
    const text=await evaluate(`document.querySelector('article').innerText`);
    for(const label of tripType==='multi-city'?['CITY LEG 1','CITY LEG 2']:['OUTBOUND','RETURN'])assert.ok(text.includes(label));
    evidence[tripType]={...summary(result),continuationStatus:next.status,completeOffers:next.body.data.length,bothLegsRendered:true,total:complete.price,currency:complete.currency};
    await shot(`${tripType}-live`);
    if(tripType==='multi-city'&&await evaluate(`Boolean(Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Booking options'))`)){
      await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Booking options').click()`);
      await until(()=>evaluate(`window.__qaRequests.some(r=>r.path.includes('/booking-options/')&&r.done)`),'real booking options');
      const booking=await evaluate(`window.__qaRequests.filter(r=>r.path.includes('/booking-options/')).at(-1)`);assert.equal(booking.status,200,booking.body.message);
      evidence.booking={status:booking.status,options:booking.body.data.length,handoffLinks:booking.body.data.filter(o=>o.bookingUrl).length,source:'actual provider; no purchase submitted'};
    }
  }

  console.log('Live browser: tracking actual BOM -> DEL offer and Fare Intelligence');
  await home();await choose(0,'Mumbai','BOM');await choose(1,'Delhi','DEL');await dates([day(28)]);
  const result=await submit({origin:'BOM',destination:'DEL',tripType:'one-way'});
  const selected=[...result.body.data].sort((a,b)=>a.price-b.price)[0];
  await fill('article input[type="number"]',String(Math.ceil(selected.price*1.5)));
  await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Track this flight').click()`);
  await until(()=>TrackedFlight.exists({userId}),'real tracked flight');
  const tracked=await TrackedFlight.findOne({userId}).lean();assert.equal(tracked.origin,'BOM');assert.equal(tracked.destination,'DEL');assert.equal(tracked.currentPrice,selected.price);
  await until(()=>evaluate(`document.querySelector('[aria-label="Flight results actions"] a')?.getAttribute('href')==='/dashboard?flight=${tracked._id}'`),'tracked Dashboard link');
  await evaluate(`window.__liveQaDocument='${randomUUID()}'`);
  const documentId=await evaluate('window.__liveQaDocument');
  const searchesBefore=await evaluate(`window.__qaRequests.filter(r=>r.path==='/api/flights/search').length`);
  await evaluate(`document.querySelector('[aria-label="Flight results actions"] a').click()`);
  await until(()=>evaluate(`location.pathname==='/dashboard'&&location.search==='?flight=${tracked._id}'`),'live Dashboard link navigation');
  assert.equal(await evaluate('window.__liveQaDocument'),documentId);
  await evaluate('history.back()');
  await until(()=>evaluate(`location.pathname==='/results'&&Boolean(document.querySelector('article'))`),'live results after Back');
  assert.equal(await evaluate(`window.__qaRequests.filter(r=>r.path==='/api/flights/search').length`),searchesBefore);
  assert.equal(await TrackedFlight.countDocuments({userId}),1);
  evidence.dashboardNavigation={clientSide:true,trackedContext:true,backPreservesResults:true,noDuplicateSearch:true,noDuplicateTracking:true};
  await evaluate(`document.querySelector('[aria-label="Flight results actions"] a').click()`);
  await until(()=>evaluate(`Boolean(document.querySelector('#tracked-flight-${tracked._id}'))&&Boolean(document.querySelector('[aria-label="Fare Intelligence"] [aria-label="Select fare day"] button'))`),'live dashboard fare controls');
  const explorer=await signedRequest(`/tracked-flights/${tracked._id}/fare-intelligence?mode=assumption&market=normal`);assert.equal(explorer.status,200);assert.equal(explorer.body.baseline.currentFare,selected.price);
  assert.equal(explorer.body.daily.points.length,15);
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="Fare Intelligence"] button')).find(b=>b.textContent==='14 days').click()`);
  for(const dayNumber of [1,2,3,4,7,14]){
    await evaluate(`Array.from(document.querySelectorAll('[aria-label="Select fare day"] button')).find(b=>b.textContent==='Day ${dayNumber}').click()`);
    const expected=new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(explorer.body.daily.points[dayNumber].central);
    await until(()=>evaluate(`document.querySelector('[aria-label="Selected day analysis"]').innerText.includes(${JSON.stringify(expected)})`),`day ${dayNumber} matches backend`);
  }
  assert.ok(await evaluate(`Boolean(document.querySelector('[aria-label="Interactive day-wise fare scenario graph"]'))`));
  evidence.fareIntelligence={referenceFare:explorer.body.baseline.currentFare,currency:explorer.body.baseline.currency,scenarioPoints:15,daysVerified:[1,2,3,4,7,14],graphRendered:true,source:'selected genuine provider offer; existing scenario mathematics'};
  await evaluate(`document.querySelector('[aria-label="Fare Intelligence"]').scrollIntoView({block:'start'})`);await shot('fare-intelligence-live');
  const observationsBefore=await PriceObservation.countDocuments({trackedFlightId:tracked._id});
  const leased=await TrackedFlight.findOneAndUpdate({_id:tracked._id,userId,status:'active',checkLeaseOwner:null},{$set:{checkLeaseOwner:randomUUID(),checkLeaseUntil:new Date(Date.now()+10*60_000)}},{returnDocument:'after'});
  assert.ok(leased,'QA worker must acquire its own real lease');
  await processFlight(leased);
  const refreshed=await TrackedFlight.findById(tracked._id).lean();assert.equal(refreshed.lastCheckError,null);assert.ok(refreshed.currentPrice>0);
  assert.ok(refreshed.lastCheckedAt,'the worker must actually commit the verified quote');
  assert.equal(refreshed.checkLeaseOwner,null,'committed worker releases its lease');
  const observations=await PriceObservation.find({trackedFlightId:tracked._id}).sort({observedAt:1}).lean();assert.ok(observations.length>=observationsBefore);assert.equal(observations.at(-1).price,refreshed.currentPrice);
  evidence.tracking={genuineSelectedFare:selected.price,refreshedFare:refreshed.currentPrice,currency:refreshed.currency,flightNumber:refreshed.flightNumber,workerMatched:true,observationsBefore,observationsAfter:observations.length,targetNotifications:await Notification.countDocuments({userId,type:'TARGET_REACHED'}),quoteObservedAt:refreshed.quoteObservedAt};
  await call('Page.reload');await until(()=>evaluate(`Boolean(document.querySelector('#tracked-flight-${tracked._id}'))`),'tracking persists after reload');
  evidence.tracking.refreshPersisted=true;evidence.runtimeErrors=browser.errors;assert.deepEqual(browser.errors,[]);
  await pause(1000);
  evidence.dashboardRequests=await evaluate(`window.__qaRequests.filter(r=>r.done).map(r=>({path:r.path,status:r.status,eventStatus:r.body.eventIntelligence?.status,marketStatus:r.body.market?.status}))`);
} catch(error){evidence.failure=error.message;console.error(error.message);process.exitCode=1;}
finally{
  await browser?.close();userId ||= (await User.findOne({email}).lean())?._id;
  if(userId){for(const Model of [PriceObservation,Notification,DisruptionPrediction,FareIntelligenceAnalysis,IntelligenceReport,TrackedFlight,AuthSession])await Model.deleteMany({userId});await User.deleteOne({_id:userId});await ProviderState.deleteMany({key:{$regex:`^fare-market:${userId}:`}});}
  if(existing){evidence.existingHistoryBefore=existing;evidence.existingHistoryAfter=await savedHistory();evidence.existingHistoryPreserved=evidence.existingHistoryAfter.sha256===existing.sha256;if(!evidence.existingHistoryPreserved){evidence.failure ||= 'Pre-existing history changed during verification';process.exitCode=1;}}
  await closeDatabase();await mkdir(output,{recursive:true});
  const serialized=JSON.stringify(evidence,null,2);assert.ok(!serialized.includes(process.env.SERPAPI_API_KEY),'provider credential must not enter artifacts');
  await writeFile(`${output}/browser-live.json`,serialized);console.log(JSON.stringify(evidence));
}
