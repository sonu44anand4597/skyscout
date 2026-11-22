// Targeted live browser check after separate-ticket booking normalization changed.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { browserSession, until } from './browser-session.mjs';

const output='../docs/qa/provider-restore-2026-10-31';
const previous=JSON.parse(await readFile(`${output}/browser-live.json`,'utf8'));
const legs=JSON.parse(previous['multi-city'].query.legs);
const evidence={executedAt:new Date().toISOString(),source:'Actual browser/API/provider, same multi-city itinerary; no booking submitted'};
let browser;
try{
  browser=await browserSession(9238);const{call,evaluate,fill}=browser;
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const original=window.fetch.bind(window);window.__qaRecords=[];window.fetch=async(...args)=>{const r=await original(...args);const path=new URL(String(args[0]),location.href).pathname;if(path.includes('/flights/')&&!path.includes('/airports')){const entry={path,status:r.status};window.__qaRecords.push(entry);r.clone().json().then(body=>{entry.body=body;entry.done=true})}return r}})()`});
  await call('Page.navigate',{url:'http://127.0.0.1:5173/#flight-search'});
  await until(()=>evaluate(`Boolean(document.querySelector('input[value="multi-city"]'))`),'search form');
  await evaluate(`document.querySelector('input[value="multi-city"]').click()`);
  for(const[index,code]of[legs[0].from,legs[0].to,legs[1].from,legs[1].to].entries()){
    const id=await evaluate(`document.querySelectorAll('#flight-search input[role="combobox"]')[${index}].id`);
    await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);await fill(`[id=${JSON.stringify(id)}]`,code);
    await until(()=>evaluate(`Array.from(document.querySelectorAll('[role="option"]')).some(a=>a.innerText.includes('${code}'))`),code);
    await evaluate(`Array.from(document.querySelectorAll('[role="option"]')).find(a=>a.innerText.includes('${code}')).click()`);
  }
  const ids=await evaluate(`Array.from(document.querySelectorAll('#flight-search input[type="date"]')).map(i=>i.id)`);
  for(let i=0;i<2;i++)await fill(`[id=${JSON.stringify(ids[i])}]`,legs[i].date);
  await evaluate(`Array.from(document.querySelectorAll('#flight-search button')).find(b=>b.textContent.trim()==='Search flights').click()`);
  await until(()=>evaluate(`Boolean(Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Choose city leg 1'&&!b.disabled))`),'live first leg');
  await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Choose city leg 1'&&!b.disabled).click()`);
  await until(()=>evaluate(`Boolean(Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Booking options'))`),'live complete itinerary');
  await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Booking options').click()`);
  await until(()=>evaluate(`window.__qaRecords.some(r=>r.path.includes('/booking-options/')&&r.done)`),'live booking response');
  const booking=await evaluate(`window.__qaRecords.filter(r=>r.path.includes('/booking-options/')).at(-1)`);
  assert.equal(booking.status,200,booking.body.message);
  evidence.query=previous['multi-city'].query;evidence.status=booking.status;evidence.options=booking.body.data.map(o=>({provider:o.provider,price:o.price,currency:o.currency,fareName:o.fareName,hasBookingUrl:Boolean(o.bookingUrl),hasPostData:Boolean(o.bookingPostData)}));
  assert.ok(evidence.options.some(o=>o.hasBookingUrl),'actual provider handoff required');
  await until(()=>evaluate(`Boolean(document.querySelector('article form[target="_blank"],article a[target="_blank"]'))`),'safe handoff rendered');
  evidence.renderedHandoffs=await evaluate(`document.querySelectorAll('article form[target="_blank"],article a[target="_blank"]').length`);
  await evaluate(`Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Booking options').scrollIntoView({block:'center'})`);
  const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(`${output}/booking-live.png`,Buffer.from(shot.data,'base64'));
  evidence.runtimeErrors=browser.errors;assert.deepEqual(browser.errors,[]);
}catch(error){evidence.failure=error.message;console.error(error.message);process.exitCode=1;}
finally{await browser?.close();const serialized=JSON.stringify(evidence,null,2);assert.ok(!serialized.includes(process.env.SERPAPI_API_KEY));await writeFile(`${output}/booking-live.json`,serialized);console.log(JSON.stringify(evidence));}
