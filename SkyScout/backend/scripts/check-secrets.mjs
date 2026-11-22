// Never print matches or secret values. Known configured credentials are checked
// in source/bundles; Git history is checked separately when commits exist.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('..');
const skip = new Set(['node_modules', '.git', '.venv', '__pycache__', 'qa-artifacts', 'data', 'artifacts']);
const credentials = ['SERPAPI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_MAPS_API_KEY', 'MONGODB_URI'].map((name) => [name, process.env[name]]).filter(([, value]) => value && value.length > 12);
const findings = [];
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await inspect(file); continue; }
    if (entry.name.startsWith('.env') || !/\.(?:js|jsx|mjs|json|html|md|ya?ml|css|py|txt)$/.test(entry.name)) continue;
    const content = await readFile(file, 'utf8');
    for (const [name, secret] of credentials) if (content.includes(secret)) findings.push({ file: path.relative(root, file), credentialName: name });
  }
}
await inspect(root);
console.log(JSON.stringify({ checkedConfiguredCredentials: credentials.length, findings }));
if (findings.length) process.exitCode = 1;
