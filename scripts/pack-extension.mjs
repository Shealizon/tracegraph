import fs from 'node:fs/promises';
import path from 'node:path';

const input = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: npm run pack:extension -- <extension-directory> [output.json]');
  process.exit(1);
}

const manifest = JSON.parse(await fs.readFile(path.join(input, 'manifest.json'), 'utf8'));
const referenced = new Set([
  ...(manifest.skills || []).map((item) => item.file),
  ...(manifest.tools || []).map((item) => item.entry),
]);
const files = [];
for (const relative of referenced) {
  const normalized = String(relative).replace(/\\/g, '/');
  const data = await fs.readFile(path.resolve(input, normalized));
  const utf8 = /\.(?:py|md|txt|json|ya?ml)$/i.test(normalized);
  files.push({
    path: normalized,
    encoding: utf8 ? 'utf8' : 'base64',
    data: utf8 ? data.toString('utf8') : data.toString('base64'),
  });
}
const bundle = { format: 'paper-graph-extension@1', manifest, files };
const output = path.resolve(process.argv[3] || `${manifest.id}-${manifest.version}.extension.json`);
await fs.writeFile(output, JSON.stringify(bundle, null, 2));
console.log(output);
