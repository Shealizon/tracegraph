// 检查节点 title 元素的计算样式
const PORT = process.argv[2] || '9223';
const SEL = process.argv[3] || 'thm:audit';
const base = `http://127.0.0.1:${PORT}`;
const v = await (await fetch(base + '/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0, S = null;
const rpc = (m, p = {}) => new Promise((res, rej) => {
  const i = ++id;
  const h = (e) => { const x = JSON.parse(e.data); if (x.id === i) { ws.removeEventListener('message', h); x.error ? rej(new Error(x.error.message)) : res(x.result); } };
  ws.addEventListener('message', h);
  const pl = { id: i, method: m, params: p }; if (S) pl.sessionId = S; ws.send(JSON.stringify(pl));
});
const t = await rpc('Target.createTarget', { url: 'http://localhost:5183/' });
const a = await rpc('Target.attachToTarget', { targetId: t.targetId, flatten: true });
S = a.sessionId;
await rpc('Runtime.enable');
await new Promise((r) => setTimeout(r, 5200));
const expr = `(() => {
  const el = document.querySelector('.node[data-id="${SEL}"]');
  if (!el) return 'NO NODE';
  const tt = el.querySelector('.node-title');
  const cs = getComputedStyle(tt);
  const ecs = getComputedStyle(el);
  const tr = tt.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  return JSON.stringify({
    titleText: tt.textContent, hidden: tt.classList.contains('hide'),
    titleRect: {x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height)},
    nodeRect: {x: Math.round(er.x), y: Math.round(er.y), w: Math.round(er.width), h: Math.round(er.height)},
    nodeOverflow: ecs.overflow, nodeDisplay: ecs.display, nodeFlexDir: ecs.flexDirection,
    titleVisibility: cs.visibility, titleColor: cs.color, titleOpacity: cs.opacity,
    insideNode: (tr.top >= er.top - 1 && tr.bottom <= er.bottom + 1)
  });
})()`;
const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result.value);
ws.close();
