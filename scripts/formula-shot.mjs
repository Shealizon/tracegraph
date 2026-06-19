// 注入样例项目并展开一张含公式的卡片，截图 + 报告 KaTeX 渲染错误数
//   用法： node scripts/formula-shot.mjs samples/xxx.json C:/temp/xxx.png
import { readFileSync, writeFileSync } from 'node:fs';

const [sample, out] = process.argv.slice(2);
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
await rpc(ws, 'Page.enable');
await rpc(ws, 'Runtime.enable');
await sleep(4800);
const id = await ev(ws, `(async () => {
  const ctx = window.__ctx;
  const pa = await import('/src/project/projectAdapter.js');
  const store = await import('/src/project/store.js');
  const payload = ${payload};
  const doc = pa.graphToDocument(payload, 'Formula Test');
  const pid = 'fx-' + Date.now();
  const proj = pa.normalizeProject({ id: pid, name: 'Formula Test', documents: [doc], config: { enabledDocumentIds: [doc.id], disabledNodeIds: [], disabledRelationKeys: [], viewState: {} } });
  await store.saveProject(ctx.db, proj);
  return pid;
})()`);
await rpc(ws, 'Page.navigate', { url: `http://localhost:5183/?screen=main&project=${id}` });
await sleep(6000);
const opened = await ev(ws, `(() => {
  const ctx = window.__ctx;
  const n = ctx.model.nodes.find((x) => x.statementBody && x.statementBody.length > 15);
  if (!n) return 'none';
  ctx.modals.openFromNode(n, { x: 0, y: 0 });
  ctx.graph.focusNode(n.id, 1.0);
  return n.id;
})()`);
await sleep(1600);
const info = await ev(ws, `(() => {
  const katexErr = document.querySelectorAll('.katex-error').length;
  const body = document.querySelector('.modal-body .statement');
  return JSON.stringify({ katexErrors: katexErr, mathError: document.querySelectorAll('.modal .math-error').length, katex: document.querySelectorAll('.modal .katex').length, bodyHtml: (body ? body.innerHTML : '').slice(0, 220) });
})()`);
console.log('opened node:', opened);
console.log('render:', info);
const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('shot:', out);
ws.close();
