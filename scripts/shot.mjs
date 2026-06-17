// Quick multi-screen screenshot helper via CDP
import { writeFileSync } from 'node:fs';

const URL = process.argv[2];
const OUT = process.argv[3] || 'shot.png';
const SCENARIO = process.argv[4] || 'plain';
const base = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idc = 0, SESSION = null;
function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idc;
    const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
    ws.addEventListener('message', onMsg);
    const payload = { id, method, params };
    if (SESSION) payload.sessionId = SESSION;
    ws.send(JSON.stringify(payload));
  });
}
const evaluate = async (ws, expr) => (await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

async function main() {
  const j = await (await fetch(`${base}/json/version`)).json();
  const ws = new WebSocket(j.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  const { targetId } = await rpc(ws, 'Target.createTarget', { url: URL });
  const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  SESSION = att.sessionId;
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (process.env.THEME) {
    await sleep(600);
    await evaluate(ws, `localStorage.setItem('hg-theme-mode', ${JSON.stringify(process.env.THEME)})`);
    await rpc(ws, 'Page.reload', {});
  }
  await sleep(SCENARIO === 'main' ? 4800 : 1700);

  if (SCENARIO === 'config' || SCENARIO === 'config-adv') {
    await evaluate(ws, `(() => { const b = document.querySelector('[data-config]'); if (b) b.click(); return !!b; })()`);
    await sleep(1000);
    if (SCENARIO === 'config-adv') {
      await evaluate(ws, `(() => { const h = document.querySelector('[data-adv] .disc-head'); if (h) h.click(); return !!h; })()`);
      await sleep(500);
    }
  } else if (SCENARIO === 'main-modal') {
    await evaluate(ws, `(() => { const ctx = window.__ctx; const n = ctx.model.nodes.find(x=>!x._isLeaf) || ctx.model.nodes[0]; ctx.modals.openFromNode(n, {x:0,y:0}); return n.id; })()`);
    await sleep(1200);
  }

  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved', OUT);
  await rpc(ws, 'Target.closeTarget', { targetId });
  ws.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
