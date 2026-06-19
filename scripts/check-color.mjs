import { readFileSync } from 'node:fs';
const sample = process.argv[2];
const payload = readFileSync(sample, 'utf8');
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0, SESSION = null;
function rpc(ws, m, p = {}) { return new Promise((res, rej) => { const id = ++idc; const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } }; ws.addEventListener('message', on); const pl = { id, method: m, params: p }; if (SESSION) pl.sessionId = SESSION; ws.send(JSON.stringify(pl)); }); }
const ev = (e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result && r.result.value);
const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/?screen=main' });
const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true }); SESSION = att.sessionId;
await rpc(ws, 'Runtime.enable'); await sleep(4600);
const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const payload=${payload};const doc=pa.graphToDocument(payload,'CC');const pid='cc-'+Date.now();await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:'CC',documents:[doc],config:{enabledDocumentIds:[doc.id],disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` });
await sleep(5200);
const out = await ev(`(()=>{const ctx=window.__ctx;const prof=ctx.model.meta.profileResolved;const colors=Object.fromEntries((prof.types||[]).map(t=>[t.id,t.color]));const sample=ctx.model.nodes.slice(0,6).map(n=>{const el=ctx.graph.nodeEls.get(n.id);return {type:n.type,nc:el?getComputedStyle(el).getPropertyValue('--node-color').trim():'?'}});return JSON.stringify({profileColors:colors,nodes:sample});})()`);
console.log(out);
ws.close();
