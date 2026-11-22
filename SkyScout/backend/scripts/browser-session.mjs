import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, label, attempts = 200) {
  for (let index = 0; index < attempts; index++) {
    try { if (await check()) return; }
    catch (error) {
      // Page.reload/navigation invalidates a CDP execution context briefly.
      // Retry that expected transition, without swallowing assertions/errors.
      if (!/Execution context was destroyed|Cannot find context|Inspected target navigated or closed/i.test(error.message)) throw error;
    }
    await pause(250);
  }
  throw new Error(`Timed out: ${label}`);
}
export async function browserSession(port = 9235) {
  const root = path.resolve('../qa-artifacts');
  const profile = path.join(root, `browser-${randomUUID()}`);
  await mkdir(profile, { recursive: true });
  const child = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let launchError; child.on('error', (error) => { launchError = error; });
  let tab;
  await until(async () => { if (launchError) throw launchError; try { tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); return Boolean(tab.webSocketDebuggerUrl); } catch { return false; } }, 'browser startup', 80);
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const jobs = new Map(); const errors = []; let sequence = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { jobs.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    jobs.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const job = jobs.get(message.id); if (!job) return; jobs.delete(message.id);
    if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
  });
  const evaluate = async (expression) => { const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result.value; };
  const fill = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw new Error('Input missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await call('Runtime.enable'); await call('Page.enable');
  return { call, evaluate, fill, errors, close: async () => {
    socket.close(); child.kill(); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(1500)]);
    if (profile.startsWith(root + path.sep)) await rm(profile, { recursive: true, force: true }).catch(() => {});
  } };
}
