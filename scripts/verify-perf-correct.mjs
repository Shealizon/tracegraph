import { readFileSync, writeFileSync } from 'node:fs';
const files = ['bio', 'cl', 'med'].map((n) => readFileSync(`samples/${n}.json`, 'utf8'));
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
await rpc(ws, 'Runtime.enable'); await rpc(ws, 'Page.enable');
const errors = [];
ws.addEventListener('message', (m) => { const x = JSON.parse(m.data); if (x.method === 'Runtime.exceptionThrown') errors.push(x.params?.exceptionDetails?.text || 'exception'); if (x.method === 'Runtime.consoleAPICalled' && x.params?.type === 'error') errors.push((x.params.args || []).map(a => a.value).join(' ')); });
await sleep(3500);
const arr = '[' + files.join(',') + ']';
const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const raws=${arr};const docs=raws.map((r,i)=>pa.graphToDocument(r,'doc'+i));const pid='vc-'+Date.now();await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:'校验',documents:docs,config:{enabledDocumentIds:docs.map(d=>d.id),disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` });
await sleep(3000);
for (let i = 0; i < 20; i++) { const ok = await ev(`!!(window.__ctx&&window.__ctx.model&&window.__ctx.model.meta.projectId==='${id}'&&window.__ctx.graph&&window.__ctx.graph.edgeSel)`); if (ok) break; await sleep(500); }
const r1 = await ev(`(()=>{const g=window.__ctx.graph;const visE=g.links.filter(l=>g._edgeVisible(l)).length;const paths=g.gEdges.selectAll('path').size();const polys=g.gArrows.selectAll('polygon').size();const dots=g.gAnchors.selectAll('circle').size();return JSON.stringify({visibleEdges:visE,paths,polys,dots,dotsExpected:visE*2});})()`);
console.log('counts', r1);
// 触发节点高亮，检查 hi 类生效
const r2 = await ev(`(()=>{const g=window.__ctx.graph;const n=window.__ctx.model.nodes.find(x=>g.model.usedBy.get(x.id)?.size||g.model.deps.get(x.id)?.size);if(!n)return 'no-node';g.highlightNode?g.highlightNode(n.id):0;const hi=g.gEdges.selectAll('path.hi').size();return JSON.stringify({node:n.id,hiPaths:hi});})()`);
console.log('highlight', r2);
await sleep(400); await shot('C:/temp/verify-perf.png');
console.log('consoleErrors', JSON.stringify(errors.slice(0, 8)));
ws.close();
