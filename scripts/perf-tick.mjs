import { readFileSync } from 'node:fs';
// 构造一个多文件大项目，复现卡顿场景
const files = ['bio', 'cl', 'med', 'hardy', 'uncertainty', 'beurling'].map((n) => readFileSync(`samples/${n}.json`, 'utf8'));
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0, SESSION = null;
function rpc(ws, m, p = {}) { return new Promise((res, rej) => { const id = ++idc; const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } }; ws.addEventListener('message', on); const pl = { id, method: m, params: p }; if (SESSION) pl.sessionId = SESSION; ws.send(JSON.stringify(pl)); }); }
const ev = (e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result && r.result.value);
const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/?screen=main' });
const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true }); SESSION = att.sessionId;
await rpc(ws, 'Runtime.enable'); await rpc(ws, 'Page.enable'); await sleep(4200);
const arr = '[' + files.join(',') + ']';
const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const raws=${arr};const docs=raws.map((r,i)=>pa.graphToDocument(r,'doc'+i));const pid='pf-'+Date.now();await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:'压测多文件',documents:docs,config:{enabledDocumentIds:docs.map(d=>d.id),disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` }); await sleep(3000);
// 轮询直到目标项目就绪
for (let i = 0; i < 20; i++) { const ok = await ev(`!!(window.__ctx&&window.__ctx.model&&window.__ctx.model.meta.projectId==='${id}'&&window.__ctx.graph&&window.__ctx.graph.links)`); if (ok) break; await sleep(500); }
const stats = await ev(`(()=>{const ctx=window.__ctx;const g=ctx.graph;const N=ctx.model.nodes.length,E=ctx.model.edges.length,L=g.links.length;
const bench=(fn)=>{for(let i=0;i<20;i++)fn();let t=performance.now();for(let i=0;i<200;i++)fn();return +((performance.now()-t)/200).toFixed(3);};
const re=bench(()=>g._renderEdges());      // 旧每帧路径：完整重建
const pe=bench(()=>g._positionEdges());     // 新每帧路径：轻量定位
const tk=bench(()=>g._tick());
const visE=g.links.filter(l=>g._edgeVisible(l)).length;
return JSON.stringify({project:ctx.model.meta.projectId,N,E,links:L,visibleEdges:visE,renderEdges_ms:re,positionEdges_ms:pe,tick_ms:tk,speedup:+(re/pe).toFixed(1)});})()`);
console.log(stats);
ws.close();
