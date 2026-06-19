// 注入样例，截普通视图（看聚拢）与远景视图（看大字缩放）
//   用法： node scripts/verify31.mjs samples/xxx.json C:/temp/prefix
import { readFileSync, writeFileSync } from 'node:fs';
const [sample, prefix] = process.argv.slice(2);
const payload = readFileSync(sample, 'utf8');
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0, SESSION = null;
function rpc(ws, m, p = {}) { return new Promise((res, rej) => { const id = ++idc; const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } }; ws.addEventListener('message', on); const pl = { id, method: m, params: p }; if (SESSION) pl.sessionId = SESSION; ws.send(JSON.stringify(pl)); }); }
const ev = (ws, e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result && r.result.value);
const shot = async (ws, f) => { const s = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(s.data, 'base64')); console.log('shot:', f); };
const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/?screen=main' });
const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true }); SESSION = att.sessionId;
await rpc(ws, 'Page.enable'); await rpc(ws, 'Runtime.enable'); await sleep(4800);
const id = await ev(ws, `(async () => { const ctx=window.__ctx; const pa=await import('/src/project/projectAdapter.js'); const store=await import('/src/project/store.js'); const payload=${payload}; const doc=pa.graphToDocument(payload,'V31'); const pid='v31-'+Date.now(); await store.saveProject(ctx.db, pa.normalizeProject({id:pid,name:'V31',documents:[doc],config:{enabledDocumentIds:[doc.id],disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}})); return pid; })()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` });
await sleep(5000);
await ev(ws, `(()=>{ const m=window.__ctx.modals; window.__ctx.model.nodes.filter(n=>n.type!=='bib').forEach(n=>m.openFromNode(n)); window.__ctx.setMode('show-modals-only'); window.__ctx.graph.reheat(0.9); return 1; })()`);
await sleep(3500);
await ev(ws, `window.__ctx.graph.setZoomScale(0.6)`); await sleep(800);
await shot(ws, `${prefix}-normal.png`);
await ev(ws, `window.__ctx.graph.setZoomScale(0.26)`); await sleep(1500);
await shot(ws, `${prefix}-far.png`);
ws.close();
