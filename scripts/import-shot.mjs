// 把样例 JSON 注入为项目并截图（CDP）
//   用法： node scripts/import-shot.mjs samples/xxx.json C:/temp/xxx.png "Name"
import { readFileSync, writeFileSync } from 'node:fs';

const [sample, out, name = 'Sample'] = process.argv.slice(2);
const payload = readFileSync(sample, 'utf8');
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0, SESSION = null;
function rpc(ws, m, p = {}) {
  return new Promise((res, rej) => {
    const id = ++idc;
    const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } };
    ws.addEventListener('message', on);
    const pl = { id, method: m, params: p }; if (SESSION) pl.sessionId = SESSION; ws.send(JSON.stringify(pl));
  });
}
const ev = (ws, e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result && r.result.value);

const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/?screen=main' });
const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
SESSION = att.sessionId;
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 200));
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
});
await rpc(ws, 'Page.enable');
await rpc(ws, 'Runtime.enable');
await sleep(4800);
const id = await ev(ws, `(async () => {
  const ctx = window.__ctx;
  const pa = await import('/src/project/projectAdapter.js');
  const store = await import('/src/project/store.js');
  const payload = ${payload};
  const doc = pa.graphToDocument(payload, ${JSON.stringify(name)});
  const pid = 'sample-' + Date.now();
  const proj = pa.normalizeProject({ id: pid, name: ${JSON.stringify(name)}, documents: [doc], config: { enabledDocumentIds: [doc.id], disabledNodeIds: [], disabledRelationKeys: [], viewState: {} } });
  await store.saveProject(ctx.db, proj);
  return pid;
})()`);
console.log('saved project:', id);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` });
await sleep(6000);
const dom = await ev(ws, `JSON.stringify({nodes:document.querySelectorAll('.node').length, edges:document.querySelectorAll('.edge-path').length, title:(document.querySelector('.side-title')||{}).textContent, sub:(document.querySelector('.side-sub')||{}).textContent})`);
console.log('DOM:', dom);
console.log('console errors:', errors.length);
errors.slice(0, 8).forEach((e) => console.log('  ! ' + e));
const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('shot:', out);
ws.close();
