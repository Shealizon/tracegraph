// 复现：两个文档共用节点 id method:training / result:r1，验证唯一化修复
const mk = (tag) => JSON.stringify({
  format: 'relation-graph@1',
  meta: { title: 'Doc' + tag, defaultType: 'method' },
  types: [
    { id: 'method', label: '方法', color: '#7dd3a8' },
    { id: 'result', label: '结论', color: '#ff9e64' },
    { id: 'reference', label: '文献', color: '#8a8a98', leaf: true },
  ],
  nodes: [
    { id: 'method:training', type: 'method', number: '1', title: '基于帧选择的模型适配训练' + tag, sections: [{ kind: 'statement', body: '训练 ' + tag }], refs: [] },
    { id: 'result:r1', type: 'result', number: '2', title: '结论' + tag, sections: [{ kind: 'statement', body: '由方法' }], refs: [{ target: 'method:training', relation: 'ref', where: 'statement' }] },
  ],
});
const A = mk('A'), B = mk('B');
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0, SESSION = null;
function rpc(ws, m, p = {}) { return new Promise((res, rej) => { const id = ++idc; const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } }; ws.addEventListener('message', on); const pl = { id, method: m, params: p }; if (SESSION) pl.sessionId = SESSION; ws.send(JSON.stringify(pl)); }); }
const ev = (e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result && r.result.value);
const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/?screen=main' });
const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true }); SESSION = att.sessionId;
await rpc(ws, 'Runtime.enable'); await rpc(ws, 'Page.enable'); await sleep(3500);
const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const a=pa.graphToDocument(${A},'DocA');const b=pa.graphToDocument(${B},'DocB');const pid='dup-'+Date.now();await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:'重复id',documents:[a,b],config:{enabledDocumentIds:[a.id,b.id],disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` }); await sleep(3500);
for (let i = 0; i < 20; i++) { const ok = await ev(`!!(window.__ctx&&window.__ctx.model&&window.__ctx.model.meta.projectId==='${id}'&&window.__ctx.graph&&window.__ctx.graph.nodeEls)`); if (ok) break; await sleep(500); }
const r = await ev(`(()=>{const ctx=window.__ctx;const g=ctx.graph;const ids=ctx.model.nodes.map(n=>n.id);const uniq=new Set(ids).size;const domNodes=g.nodesEl.querySelectorAll('.node').length;const trainings=ctx.model.nodes.filter(n=>n.title&&n.title.includes('帧选择'));return JSON.stringify({nodeCount:ids.length,uniqueIds:uniq,nodeEls:g.nodeEls.size,domNodes,edges:ctx.model.edges.length,trainingIds:trainings.map(t=>t.id),trainingTitles:trainings.map(t=>t.title)});})()`);
console.log('structure', r);
// 展开第二个 training 节点，检查其圆是否隐藏、是否有遗留可见同 id 圆
const r2 = await ev(`(()=>{const ctx=window.__ctx;const g=ctx.graph;const t=ctx.model.nodes.filter(n=>n.title&&n.title.includes('帧选择'))[1];g.onNodeActivate(t,g.nodeEls.get(t.id));const el=g.nodeEls.get(t.id);const hidden=el.classList.contains('node-hidden');const visibleSameId=g.nodesEl.querySelectorAll('[data-id=\"'+CSS.escape(t.id)+'\"]:not(.node-hidden)').length;return JSON.stringify({expanded:t.id,isModal:t.isModal,circleHidden:hidden,visibleCirclesSameId:visibleSameId,modalOpen:ctx.modals.open.has(t.id)});})()`);
console.log('expand', r2);
ws.close();
