// CDP 交互验证：加载页面 -> 收集 console 错误 -> 触发 ref 并排展开 + hover 预览 -> 截图
// 用法： node scripts/cdp-verify.mjs <url> <out.png> <scenario>
import { writeFileSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5199/';
const OUT = process.argv[3] || 'cdp-shot.png';
const SCENARIO = process.argv[4] || 'errors';

const base = 'http://127.0.0.1:9222';

async function getBrowserWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/json/version`);
      if (r.ok) { const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; }
    } catch {}
    await sleep(300);
  }
  throw new Error('cannot reach browser ws');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idc = 0;
let SESSION = null;
function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idc;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.addEventListener('message', onMsg);
    const payload = { id, method, params };
    if (SESSION) payload.sessionId = SESSION;
    ws.send(JSON.stringify(payload));
  });
}

const errors = [];

async function main() {
  const wsUrl = await getBrowserWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res) => (ws.onopen = res));

  // 创建页面 target 并 attach
  const { targetId } = await rpc(ws, 'Target.createTarget', { url: URL });
  const att = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  SESSION = att.sessionId;

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });

  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'DOM.enable');
  await sleep(4800); // 等首帧 + 布局

  if (SCENARIO === 'click-ref') {
    // 打开主定理 modal，点击其中第一个跨节点 ref，触发并排 + 关系箭头
    await evaluate(ws, `(() => {
      const ctx = window.__ctx;
      const n = ctx.model.nodeById.get('thm:conditional');
      ctx.modals.openFromNode(n, {x:-260,y:0});
      return 'opened';
    })()`);
    await sleep(900);
    await evaluate(ws, `(() => {
      const modal = document.querySelector('.modal[data-id="thm:conditional"]');
      const span = [...modal.querySelectorAll('.texref')].find(s => s.dataset.owner && s.dataset.owner !== 'thm:conditional');
      if (!span) return 'no-ref';
      span.dispatchEvent(new MouseEvent('click', {bubbles:true}));
      return 'clicked ' + span.dataset.target;
    })()`);
    await sleep(1200);
  } else if (SCENARIO === 'hover-ref') {
    await evaluate(ws, `(() => {
      const ctx = window.__ctx;
      ctx.modals.openFromNode(ctx.model.nodeById.get('thm:conditional'), {x:-150,y:-80});
      return 'opened';
    })()`);
    await sleep(900);
    await evaluate(ws, `(() => {
      const modal = document.querySelector('.modal[data-id="thm:conditional"]');
      const span = [...modal.querySelectorAll('.texref')].find(s => s.dataset.owner && s.dataset.owner !== 'thm:conditional');
      span.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
      return 'hovered ' + span.dataset.target;
    })()`);
    await sleep(900);
  } else if (SCENARIO === 'focus') {
    await evaluate(ws, `window.__ctx.graph.focusNode('thm:audit', 1.5)`);
    await sleep(1200);
  } else if (SCENARIO === 'spread') {
    await evaluate(ws, `(() => {
      const ctx = window.__ctx;
      const ids = ['thm:conditional','lem:gauge','lem:appell','thm:stationary','thm:verified-iteration','lem:product-halfspace'];
      ids.forEach((id) => { const n = ctx.model.nodeById.get(id); if (n) ctx.modals.openFromNode(n); });
      return 'opened ' + ids.length;
    })()`);
    await sleep(3500); // 等力分离
  } else if (SCENARIO === 'details') {
    await evaluate(ws, `(() => { window.__ctx.openDetails('thm:stationary'); return 'details'; })()`);
    await sleep(1200);
  } else if (SCENARIO === 'modals-only') {
    await evaluate(ws, `(() => {
      const ctx = window.__ctx;
      ['thm:conditional','lem:gauge','lem:appell','thm:stationary'].forEach((id,i)=>ctx.modals.openFromNode(ctx.model.nodeById.get(id),{x:(i-1.5)*430,y:0}));
      ctx.setMode('show-modals-only');
      return 'modals-only';
    })()`);
    await sleep(1400);
  } else if (SCENARIO === 'ui-controls') {
    await evaluate(ws, `(() => {
      document.querySelector('.sidebar-rail').click();
      const input = document.querySelector('.zoom-slider');
      input.value = '135';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      return document.getElementById('app').className + ' ' + document.querySelector('.zoom-val').textContent;
    })()`);
    await sleep(900);
  } else if (SCENARIO === 'node-hover') {
    await evaluate(ws, `(() => {
      const el = document.querySelector('.node[data-id="thm:audit"]');
      el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true, clientX: 480, clientY: 280}));
      return 'node-hover';
    })()`);
    await sleep(900);
  } else if (SCENARIO === 'formula-hover') {
    await evaluate(ws, `(() => {
      const ctx = window.__ctx;
      ctx.modals.openFromNode(ctx.model.nodeById.get('thm:conditional'), {x:-160,y:-80});
      return 'opened';
    })()`);
    await sleep(900);
    await evaluate(ws, `(() => {
      const modal = document.querySelector('.modal[data-id="thm:conditional"]');
      const span = [...modal.querySelectorAll('.texref-equation')].find(s => s.dataset.owner && s.dataset.owner !== 'thm:conditional') || modal.querySelector('.texref-equation');
      if (!span) return 'no-eqref';
      span.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
      return 'hovered ' + span.dataset.target;
    })()`);
    await sleep(900);
  }

  const r = await evaluate(ws, `JSON.stringify({nodes:document.querySelectorAll('.node').length, modals:document.querySelectorAll('.modal').length, edges:document.querySelectorAll('.edge-path').length, edgeDots:document.querySelectorAll('.edge-dot').length, rels:document.querySelectorAll('.rel-path').length, relDots:document.querySelectorAll('.rel-dot').length, previews:document.querySelectorAll('.modal.preview').length, nodeTips:document.querySelectorAll('.node-tip').length, collapsed:document.getElementById('app').classList.contains('sidebar-collapsed'), zoom:document.querySelector('.zoom-val')?.textContent})`);
  console.log('DOM:', r);

  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('shot saved:', OUT);
  console.log('console errors:', errors.length);
  errors.slice(0, 20).forEach((e) => console.log('  ! ' + e));

  ws.close();
}

async function evaluate(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

main().catch((e) => { console.error(e); process.exit(1); });
