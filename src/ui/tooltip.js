// =============================================================================
// ui/tooltip.js  —  全局自定义 tooltip（替代原生 title，主题一致、简约）
//
// 委托监听整个文档：任何带 title / data-tip 的元素 hover 时，剥离原生 title（避免
// 系统气泡），改用主题化浮层。动态生成的元素（卡片、菜单等）也自动生效。
// =============================================================================

let tipEl = null;
let timer = null;
let current = null;

function ensureEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'app-tip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

function targetOf(node) {
  return node && node.closest ? node.closest('[data-tip], [title]') : null;
}

function textOf(t) {
  let text = t.getAttribute('data-tip');
  if (text == null && t.hasAttribute('title')) {
    text = t.getAttribute('title') || '';
    t.setAttribute('data-tip', text);          // 缓存到 data-tip
    if (!t.hasAttribute('aria-label') && text) t.setAttribute('aria-label', text); // 保留可访问名
    t.removeAttribute('title');                 // 去掉原生 title，阻止系统气泡
  }
  return text || '';
}

function position(t) {
  const el = ensureEl();
  const r = t.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + 7;
  if (y + h > window.innerHeight - 6) y = r.top - h - 7; // 下方放不下→翻到上方
  x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
  y = Math.max(6, y);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

function show(t, text) {
  if (!document.body.contains(t)) return;
  const el = ensureEl();
  el.textContent = text;
  el.classList.add('show');
  position(t);
}

function hide() {
  clearTimeout(timer);
  current = null;
  if (tipEl) tipEl.classList.remove('show');
}

function onOver(e) {
  if (e.pointerType === 'touch') return; // 触摸无 hover，跳过
  const t = targetOf(e.target);
  if (!t || t === current) return;
  const text = textOf(t);
  if (!text) return;
  current = t;
  clearTimeout(timer);
  timer = setTimeout(() => { if (current === t) show(t, text); }, 300);
}

function onOut(e) {
  if (!current) return;
  const to = e.relatedTarget;
  if (to && current.contains && current.contains(to)) return; // 移到子元素仍在内部
  hide();
}

export function initTooltips() {
  if (window.__appTipInit) return;
  window.__appTipInit = true;
  ensureEl();
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
