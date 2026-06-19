// 单 WS 连接内为多个样例注入并截图（避免反复重启调试浏览器）
//   用法： node scripts/multishot.mjs "samples/a.json|NameA|C:/temp/a.png" "samples/b.json|NameB|C:/temp/b.png" ...
import { readFileSync, writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0;
function rpc(ws, m, p = {}, session) {
  return new Promise((res, rej) => {
    const id = ++idc;
    const on = (ev) => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(x.error.message)) : res(x.result); } };
    ws.addEventListener('message', on);
    const pl = { id, method: m, params: p }; if (session) pl.sessionId = session; ws.send(JSON.stringify(pl));
  });
}
const v = await (await fetch(`${base}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
for (const it of process.argv.slice(2)) {
  const [sample, name, out] = it.split('|');
  const payload = readFileSync(sample, 'utf8');
  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'http://localhost:5183/?screen=main' });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  const ev = (e) => rpc(ws, 'Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId).then((r) => r.result && r.result.value);
  await rpc(ws, 'Runtime.enable', {}, sessionId);
  await rpc(ws, 'Page.enable', {}, sessionId);
  await sleep(4600);
  const id = await ev(`(async()=>{const ctx=window.__ctx;const pa=await import('/src/project/projectAdapter.js');const store=await import('/src/project/store.js');const payload=${payload};const doc=pa.graphToDocument(payload,${JSON.stringify(name)});const pid='ms-'+Date.now()+Math.floor(Math.random()*999);await store.saveProject(ctx.db,pa.normalizeProject({id:pid,name:${JSON.stringify(name)},documents:[doc],config:{enabledDocumentIds:[doc.id],disabledNodeIds:[],disabledRelationKeys:[],viewState:{}}}));return pid;})()`);
  await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` }, sessionId);
  await sleep(5500);
  const dom = await ev(`JSON.stringify({nodes:document.querySelectorAll('.node').length,edges:document.querySelectorAll('.edge-path').length,katexErr:document.querySelectorAll('.katex-error').length})`);
  console.log(name, '->', dom);
  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('  shot:', out);
  await rpc(ws, 'Target.closeTarget', { targetId });
}
ws.close();
