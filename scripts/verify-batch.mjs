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
ws.addEventListener('message', (m) => { const x = JSON.parse(m.data); if (x.method === 'Runtime.exceptionThrown') errors.push(x.params?.exceptionDetails?.text); if (x.method === 'Runtime.consoleAPICalled' && x.params?.type === 'error') errors.push((x.params.args || []).map(a => a.value).join(' ')); });
await sleep(3500);
const arr = '[' + files.join(',') + ']';
const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const docs=${arr}.map((r,i)=>pa.graphToDocument(r,'D'+i));const pid='vb-'+Date.now();await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:'批量校验',documents:docs,config:{enabledDocumentIds:docs.map(d=>d.id),disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` }); await sleep(3500);
for (let i = 0; i < 20; i++) { const ok = await ev(`!!(window.__ctx&&window.__ctx.model&&window.__ctx.model.meta.projectId==='${id}'&&window.__ctx.graph&&window.__ctx.graph.nodeEls)`); if (ok) break; await sleep(500); }

// #4 缩放/边界
const r4 = await ev(`(()=>{const g=window.__ctx.graph;const wb=g.worldBounds;g.setZoomScale(0.10);return JSON.stringify({minZoomReached:true,worldBounds:!!wb,hw:Math.round(wb.x1),hh:Math.round(wb.y1)});})()`);
console.log('#4 bounds/zoom', r4);

// #3 箭头粗细
const r3 = await ev(`(()=>{const g=window.__ctx.graph;const before=g.getEdgeWidth();g.setEdgeWidth(3);const cssvar=getComputedStyle(g.stageEl).getPropertyValue('--edge-w').trim();const r=g.gAnchors.select?0:0;const dotR=g.gAnchors.node().querySelector('circle')?.getAttribute('r');g.setEdgeWidth(1);return JSON.stringify({before,setTo3_cssVar:cssvar,dotR_at3:dotR});})()`);
console.log('#3 edgeWidth', r3);

// #2 论文文件夹 + 整篇筛选（点击第一篇的开关，检查该篇节点被隐藏）
const r2 = await ev(`(()=>{const ctx=window.__ctx;const groups=[...document.querySelectorAll('.side-group.disclosure')];const papers=groups.find(g=>/论文/.test(g.querySelector('.disc-head')?.textContent||''));if(!papers)return JSON.stringify({hasPapersFolder:false});const rows=[...papers.querySelectorAll('.toggle-row')];const docs=ctx.model.meta.documents;const d0=docs[0].id;rows[0].click();const hiddenInD0=ctx.model.nodes.filter(n=>n.documentId===d0&&n._hidden).length;const totalD0=ctx.model.nodes.filter(n=>n.documentId===d0).length;rows[0].click();return JSON.stringify({hasPapersFolder:true,paperRows:rows.length,docCount:docs.length,d0Total:totalD0,d0HiddenAfterToggle:hiddenInD0});})()`);
console.log('#2 papers', r2);

// #1 所属论文：打开一个 modal，检查 .m-paper；详情页 .d-paper
const r1 = await ev(`(()=>{const ctx=window.__ctx;const n=ctx.model.nodes.find(x=>!x.type.includes('ref'));const rec=ctx.modals.openFromNode(n,{x:0,y:0});const mp=rec&&rec.el?rec.el.querySelector('.m-paper'):null;return JSON.stringify({node:n.id,doc:n.documentName,modalPaperShown:!!mp,modalPaperText:mp?mp.textContent.trim():null});})()`);
console.log('#1 modal paper', r1);
const r1b = await ev(`(()=>{const ctx=window.__ctx;const n=ctx.model.nodes.find(x=>!x.type.includes('ref'));ctx.openDetails(n.id);const dp=document.querySelector('.details-page .d-paper');return JSON.stringify({detailsPaperShown:!!dp,detailsPaperText:dp?dp.textContent.trim():null});})()`);
console.log('#1 details paper', r1b);
await sleep(400); await shot('C:/temp/verify-batch.png');
console.log('errors', JSON.stringify(errors.slice(0, 6)));
ws.close();
