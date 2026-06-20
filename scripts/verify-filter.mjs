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
const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const docs=${arr}.map((r,i)=>pa.graphToDocument(r,'D'+i));const pid='vf-'+Date.now();await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:'筛选校验',documents:docs,config:{enabledDocumentIds:docs.map(d=>d.id),disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` }); await sleep(3500);
for (let i = 0; i < 20; i++) { const ok = await ev(`!!(window.__ctx&&window.__ctx.model&&window.__ctx.model.meta.projectId==='${id}'&&document.querySelector('.filter-paper'))`); if (ok) break; await sleep(500); }

// 结构：论文文件夹数量、单独「论文」分区应消失、每个文件夹有类型行 + master
const r1 = await ev(`(()=>{const folders=[...document.querySelectorAll('.filter-paper')];const noSeparatePaperSection=![...document.querySelectorAll('.disc-head')].some(h=>/^论文$/.test((h.querySelector('span:last-child')?.textContent||'').trim())&&!h.classList.contains('paper-head'));return JSON.stringify({paperFolders:folders.length,eachHasMaster:folders.every(f=>!!f.querySelector('.paper-master')),eachHasTypeRows:folders.map(f=>f.querySelectorAll('.disc-body .toggle-row').length),noSeparate论文:noSeparatePaperSection});})()`);
console.log('结构', r1);

// 折叠：点击第一个文件夹头 → collapsed
const r2 = await ev(`(()=>{const f=document.querySelector('.filter-paper');const head=f.querySelector('.paper-head');const before=f.classList.contains('collapsed');head.click();const after=f.classList.contains('collapsed');head.click();return JSON.stringify({collapseToggles:before!==after});})()`);
console.log('折叠', r2);

// 一键隐藏整篇：点 master → 该篇所有节点隐藏；再点 → 恢复
const r3 = await ev(`(()=>{const ctx=window.__ctx;const f=document.querySelector('.filter-paper');const d0=ctx.model.meta.documents[0].id;const master=f.querySelector('.paper-master');master.click();const hidden=ctx.model.nodes.filter(n=>n.documentId===d0&&n._hidden).length;const total=ctx.model.nodes.filter(n=>n.documentId===d0).length;master.click();const shownAgain=ctx.model.nodes.filter(n=>n.documentId===d0&&!n._hidden).length;return JSON.stringify({d0Total:total,hiddenAfterMaster:hidden,shownAfterUnmaster:shownAgain});})()`);
console.log('整篇显隐', r3);

// 单类型开关只影响本篇该类型：在第一篇关掉一个类型，其它篇同类型不受影响
const r4 = await ev(`(()=>{const ctx=window.__ctx;const f=document.querySelector('.filter-paper');const d0=ctx.model.meta.documents[0].id;const row=f.querySelector('.disc-body .toggle-row');row.click();const t=[...new Set(ctx.model.nodes.filter(n=>n.documentId===d0).map(n=>n.type))][0];const d0HiddenOfT=ctx.model.nodes.filter(n=>n.documentId===d0&&n.type===t&&n._hidden).length;const otherHiddenOfT=ctx.model.nodes.filter(n=>n.documentId!==d0&&n.type===t&&n._hidden).length;row.click();return JSON.stringify({firstType:t,d0HiddenOfType:d0HiddenOfT,otherDocsHiddenOfSameType:otherHiddenOfT});})()`);
console.log('按篇独立', r4);

await sleep(300); await shot('C:/temp/verify-filter.png');
console.log('errors', JSON.stringify(errors.slice(0, 5)));
ws.close();
