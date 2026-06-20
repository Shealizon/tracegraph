import { readFileSync, writeFileSync } from 'node:fs';
const A = readFileSync('samples/bio.json', 'utf8');   // 生物领域类型
const B = readFileSync('samples/cl.json', 'utf8');    // NLP 领域类型
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0, SESSION = null;
function rpc(ws, m, p = {}) { return new Promise((res, rej) => { const id = ++idc; const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } }; ws.addEventListener('message', on); const pl = { id, method: m, params: p }; if (SESSION) pl.sessionId = SESSION; ws.send(JSON.stringify(pl)); }); }
const ev = (e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result && r.result.value);
const shot = async (f) => { const s = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(s.data, 'base64')); console.log('shot', f); };
const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/?screen=main' });
const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true }); SESSION = att.sessionId;
await rpc(ws, 'Runtime.enable'); await rpc(ws, 'Page.enable'); await sleep(4200);
const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const a=pa.graphToDocument(${A},'bio');const b=pa.graphToDocument(${B},'cl');const pid='mc-'+Date.now();await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:'多文件配色',documents:[a,b],config:{enabledDocumentIds:[a.id,b.id],disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` }); await sleep(5200);
// 列出每个类型的解析颜色
const report = await ev(`(()=>{const ctx=window.__ctx;const prof=ctx.model.meta.profileResolved;const types=prof.types.map(t=>({id:t.id,label:t.label,color:t.color}));const used=[...new Set(ctx.model.nodes.map(n=>n.type))];const sch=ctx.model;const out=used.map(tp=>{const def=prof.typeById[tp];return {type:tp,inProfile:!!def,color:def?def.color:'(grey-fallback #8a8a98)'};});return JSON.stringify({typeCount:types.length,usedTypes:out},null,0);})()`);
console.log(report);
await shot('C:/temp/verify-colors.png');
ws.close();
