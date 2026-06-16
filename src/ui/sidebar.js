// =============================================================================
// ui/sidebar.js  —  侧栏（精简）
// =============================================================================
import { ICON } from './icons.js';
import { nodeTag, typeColor } from '../data/schema.js';

const THEME_MODES = [
  { mode: 'dark', icon: 'moon', title: '深色' },
  { mode: 'system', icon: 'monitor', title: '跟随系统' },
  { mode: 'light', icon: 'sun', title: '浅色' },
];
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export function buildSidebar(ctx, root) {
  root.innerHTML = '';
  const { model, graph } = ctx;
  const app = document.getElementById('app');
  app.querySelector('.sidebar-settings')?.remove();
  const rail = ensureCollapseRail(app);
  const collapsed = ctx.sidebarCollapsed ?? (localStorage.getItem('hg-sidebar-collapsed') === '1');
  const setCollapsed = (on) => {
    ctx.sidebarCollapsed = on;
    app.classList.toggle('sidebar-collapsed', on);
    localStorage.setItem('hg-sidebar-collapsed', on ? '1' : '0');
    rail.title = on ? '展开侧栏' : '折叠侧栏';
    ctx.writeHash && ctx.writeHash();
  };
  rail.onclick = () => setCollapsed(!app.classList.contains('sidebar-collapsed'));
  setCollapsed(collapsed);

  const tools = el('div', 'side-toolbar');
  tools.appendChild(buildThemeSwitch(ctx));
  root.appendChild(tools);
  const head = el('div', 'side-head');
  head.innerHTML = `<div><div class="side-title">${escapeHtml(model.meta.title || '关系图')}</div><div class="side-sub">${model.meta.counts.statements} 节点 · ${model.meta.counts.edges} 关系${model.hasCycle ? ' · 含环' : ''}</div></div>`;
  root.appendChild(head);

  // 搜索
  const grpSearch = group(root, '搜索');
  const input = el('input', 'side-search');
  input.placeholder = '编号 / 标题 / label';
  grpSearch.appendChild(input);
  const results = el('div', 'search-results');
  grpSearch.appendChild(results);
  input.addEventListener('input', () => renderSearch(ctx, input.value, results));

  // 视图
  const grpMode = group(root, '视图');
  const modeSet = el('div', 'side-segment');
  const modeBtns = {};
  for (const [key, label] of [['show-all', '显示全部节点'], ['show-modals-only', '仅显示展开框']]) {
    const b = btn(label, 'side-btn mode-radio');
    b.classList.toggle('active', ctx.mode === key);
    b.addEventListener('click', () => ctx.setMode(key));
    modeBtns[key] = b;
    modeSet.appendChild(b);
  }
  grpMode.appendChild(modeSet);
  ctx.syncModeButtons = () => Object.entries(modeBtns).forEach(([k, e]) => e.classList.toggle('active', k === ctx.mode));
  const bRaise = btn('聚焦内容参考线追踪', 'side-btn multi-btn raise-btn');
  const syncRaise = () => {
    bRaise.classList.toggle('active', ctx.refsRaiseEnabled);
    bRaise.classList.toggle('off', !ctx.refsRaiseEnabled);
  };
  bRaise.addEventListener('click', () => {
    ctx.refsRaiseEnabled = !ctx.refsRaiseEnabled;
    localStorage.setItem('hg-refs-raise', ctx.refsRaiseEnabled ? '1' : '0');
    syncRaise();
    ctx.refLayer.setRaiseEnabled(ctx.refsRaiseEnabled);
    ctx.writeHash && ctx.writeHash();
  });
  syncRaise();
  grpMode.appendChild(bRaise);
  const bClose = btn('折叠所有展开框', 'side-btn trigger-btn danger-btn');
  bClose.addEventListener('click', () => ctx.modals.closeAll());
  grpMode.appendChild(bClose);
  const bReheat = btn('重新布局', 'side-btn trigger-btn primary-btn');
  bReheat.addEventListener('click', () => graph.reheat(0.8));
  grpMode.appendChild(bReheat);

  // 过滤
  const grpFilter = group(root, '筛选');
  const types = model.meta.profileResolved?.types?.length
    ? model.meta.profileResolved.types.map((t) => [t.id, t.label || t.id])
    : [...new Set(model.nodes.map((n) => n.type))].map((t) => [t, t]);
  ctx.filterActive = ctx.filterActive || new Set(types.map((t) => t[0]));
  for (const [t, label] of types) {
    const b = btn(`<span class="dot" style="background:${typeColor(model, t)}"></span>${escapeHtml(label)}`, 'side-btn multi-btn');
    b.classList.toggle('active', ctx.filterActive.has(t));
    b.classList.toggle('off', !ctx.filterActive.has(t));
    b.addEventListener('click', () => {
      if (ctx.filterActive.has(t)) ctx.filterActive.delete(t); else ctx.filterActive.add(t);
      b.classList.toggle('active', ctx.filterActive.has(t));
      b.classList.toggle('off', !ctx.filterActive.has(t));
      applyFilter(ctx);
      ctx.writeHash && ctx.writeHash();
    });
    grpFilter.appendChild(b);
  }

  // 力参数（N4）
  const grpForce = group(root, '力度');
  grpForce.appendChild(slider('向心力', 0, 0.6, 0.005, graph.getForce('center'), (v) => { graph.setForce('center', v); ctx.writeHash && ctx.writeHash(); }));
  grpForce.appendChild(slider('排斥力', 80, 1600, 20, graph.getForce('charge'), (v) => { graph.setForce('charge', v); ctx.writeHash && ctx.writeHash(); }));
  grpForce.appendChild(slider('链接吸引', 0, 1, 0.02, graph.getForce('link'), (v) => { graph.setForce('link', v); ctx.writeHash && ctx.writeHash(); }));

  // 显示（N7）：modal 宽度
  const grpShow = group(root, '显示');
  grpShow.appendChild(slider('Modal 宽度', 280, 620, 10, ctx.modals.getWidth(), (v) => { ctx.modals.setWidth(v); ctx.writeHash && ctx.writeHash(); }, 'px'));

  // 隐藏的节点
  const grpHidden = group(root, '已隐藏');
  const hiddenList = el('div', 'hidden-list');
  grpHidden.appendChild(hiddenList);
  ctx.renderHidden = () => renderHidden(ctx, hiddenList);
  applyFilter(ctx);
  ctx.renderHidden();
}

// 三态主题分段开关：深色 / 跟随系统 / 浅色
function buildThemeSwitch(ctx) {
  const wrap = el('div', 'theme-switch');
  wrap.setAttribute('role', 'radiogroup');
  const btns = {};
  for (const { mode, icon, title } of THEME_MODES) {
    const b = el('button', 'theme-seg');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = ICON[icon] || '';
    b.addEventListener('click', () => ctx.setThemeMode(mode));
    btns[mode] = b;
    wrap.appendChild(b);
  }
  const thumb = el('span', 'theme-thumb');
  wrap.appendChild(thumb);
  ctx.syncThemeButtons = () => {
    const idx = Math.max(0, THEME_MODES.findIndex((m) => m.mode === ctx.themeMode));
    wrap.style.setProperty('--theme-idx', String(idx));
    for (const { mode } of THEME_MODES) btns[mode].classList.toggle('active', mode === ctx.themeMode);
  };
  ctx.syncThemeButtons();
  return wrap;
}

export function buildZoomControl(ctx, stageEl) {
  let panel = stageEl.querySelector('.zoom-control');
  if (panel) panel.remove();
  panel = el('div', 'zoom-control');
  const top = el('div', 'zoom-top');
  const val = el('span', 'zoom-val');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '18';
  input.max = '260';
  input.step = '1';
  input.className = 'slider zoom-slider';
  const lock = el('button', 'zoom-lock');
  lock.innerHTML = LOCK;
  lock.title = '锁定滚轮缩放';
  let locked = false;
  const sync = (k) => {
    const pct = Math.round(k * 100);
    val.textContent = `${pct}%`;
    if (document.activeElement !== input) input.value = String(pct);
  };
  input.addEventListener('input', () => ctx.graph.setZoomScale(parseFloat(input.value) / 100));
  lock.addEventListener('click', () => {
    locked = !locked;
    lock.classList.toggle('active', locked);
    ctx.graph.setZoomLocked(locked);
  });
  panel.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  panel.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
  top.appendChild(input);
  top.appendChild(lock);
  panel.appendChild(top);
  panel.appendChild(val);
  stageEl.appendChild(panel);
  ctx.graph.setZoomSync(sync);
}

function ensureCollapseRail(app) {
  let b = app.querySelector('.sidebar-rail');
  if (!b) {
    b = el('button', 'sidebar-rail');
    app.appendChild(b);
  }
  // 始终重置内容，确保折叠/展开箭头图标存在（命中旧的无图标节点时也会补上）
  b.innerHTML = `<span class="rail-ico">${CHEVRON}</span>`;
  return b;
}

function applyFilter(ctx) {
  const { graph, model } = ctx;
  for (const n of model.nodes) n._hidden = !ctx.filterActive.has(n.type);
  graph.updateVisibility();
  ctx.refLayer && ctx.refLayer.refreshRelations();
}

function renderHidden(ctx, container) {
  container.innerHTML = '';
  const ids = [...ctx.hidden];
  if (!ids.length) { container.innerHTML = `<div class="hidden-empty">无</div>`; return; }
  for (const id of ids) {
    const n = ctx.model.nodeById.get(id);
    if (!n) continue;
    const item = el('div', 'hidden-item');
    const tag = nodeTag(ctx.model, n);
    item.innerHTML = `<span>${tag} · ${escapeHtml(n.title || n.id)}</span><span class="x">↺</span>`;
    item.title = '取消隐藏';
    item.addEventListener('click', () => ctx.unhideNode(id));
    container.appendChild(item);
  }
}

function renderSearch(ctx, q, container) {
  container.innerHTML = '';
  q = q.trim().toLowerCase();
  if (!q) return;
  const { model, graph } = ctx;
  const hits = model.nodes
    .filter((n) => n.id.toLowerCase().includes(q) || (n.title || '').toLowerCase().includes(q) || String(n.number) === q || n.typeLabel.toLowerCase().includes(q))
    .slice(0, 12);
  for (const n of hits) {
    const item = el('div', 'search-item');
    item.innerHTML = `<span class="tag">${escapeHtml(nodeTag(model, n))}</span> <b>${escapeHtml(n.title || n.id)}</b>`;
    item.addEventListener('click', () => {
      graph.clearHighlight();
      if (n._userHidden) ctx.unhideNode(n.id);
      graph.focusNode(n.id, 1.0);
      const e = graph.nodeEls.get(n.id);
      if (e) { e.classList.add('search-hit'); setTimeout(() => e.classList.remove('search-hit'), 1600); }
    });
    container.appendChild(item);
  }
}

function slider(label, min, max, step, value, onInput, unit = '') {
  const wrap = el('div', 'slider-row');
  const head = el('div', 'slider-head');
  const lab = el('span', 'slider-label'); lab.textContent = label;
  const val = el('span', 'slider-val');
  const fmt = (v) => (step < 1 ? Number(v).toFixed(step < 0.05 ? 3 : 2) : Math.round(v)) + unit;
  val.textContent = fmt(value);
  head.appendChild(lab); head.appendChild(val);
  const input = document.createElement('input');
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  input.className = 'slider';
  input.addEventListener('input', () => { val.textContent = fmt(input.value); onInput(parseFloat(input.value)); });
  wrap.appendChild(head); wrap.appendChild(input);
  return wrap;
}
function group(root, label) { const g = el('div', 'side-group'); const l = el('div', 'side-label'); l.textContent = label; g.appendChild(l); root.appendChild(g); return g; }
function btn(html, cls = 'side-btn') { const b = el('button', cls); b.innerHTML = html; return b; }
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function add(root, html) { const d = document.createElement('div'); d.innerHTML = html; while (d.firstChild) root.appendChild(d.firstChild); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
