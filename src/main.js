// =============================================================================
// main.js  —  应用入口与状态机
// =============================================================================
import './styles/app.css';
import './styles/modal.css';
import { buildModel } from './model/graph.js';
import { createRenderer } from './render/tex.js';
import { ForceGraph } from './view/forceGraph.js';
import { ModalManager } from './view/modal.js';
import { RefLayer } from './view/refLayer.js';
import { buildSidebar, buildZoomControl } from './ui/sidebar.js';
import { openDetails } from './view/detailsPage.js';
import { isLeafNode } from './data/schema.js';

const model = buildModel();

// 渲染器：label -> 编号 / 类型 / 归属节点
const numberOf = (key) => model.labelIndex.get(key)?.label.number ?? (model.meta?.bib?.[key] ?? '?');
const kindOf = (key) => model.labelIndex.get(key)?.label.kind ?? model.meta.profileResolved?.defaultType ?? 'theorem';
const ownerOf = (key) => model.labelIndex.get(key)?.node.id ?? null;
const render = createRenderer({ macros: model.meta.macros, numberOf, kindOf, ownerOf });

const stageEl = document.getElementById('stage');
const svgEl = document.getElementById('edges-layer');
const nodesEl = document.getElementById('nodes-layer');
const overlayEl = document.getElementById('overlay-layer');

// ---- 应用上下文（供各模块共享） ----
const ctx = {
  model,
  render,
  numberOf,
  kindOf,
  ownerOf,
  graph: null,
  modals: null,
  refLayer: null,
  mode: 'show-all',
  refsRaiseEnabled: localStorage.getItem('hg-refs-raise') !== '0',
  // 主题模式：dark | light | system（跟随系统）
  themeMode: localStorage.getItem('hg-theme-mode') || localStorage.getItem('hg-theme') || 'system',
  theme: 'dark',
  hidden: new Set(),
  openDetails: (nodeId) => openDetails(ctx, nodeId),
};

// ---- 主题（三态：暗 / 跟随系统 / 亮） ----
const systemMql = window.matchMedia('(prefers-color-scheme: light)');
const resolveTheme = (mode) => (mode === 'system' ? (systemMql.matches ? 'light' : 'dark') : mode);
ctx.applyTheme = () => {
  ctx.theme = resolveTheme(ctx.themeMode);
  document.documentElement.setAttribute('data-theme', ctx.theme);
};
ctx.setThemeMode = (mode) => {
  ctx.themeMode = mode;
  localStorage.setItem('hg-theme-mode', mode);
  ctx.applyTheme();
  ctx.syncThemeButtons && ctx.syncThemeButtons();
};
systemMql.addEventListener('change', () => { if (ctx.themeMode === 'system') { ctx.applyTheme(); ctx.syncThemeButtons && ctx.syncThemeButtons(); } });
// 兼容旧的 setTheme 调用：直接当作选定具体主题
ctx.setTheme = (t) => ctx.setThemeMode(t);
ctx.applyTheme();

// ---- 隐藏节点管理（P8） ----
ctx.hideNode = (id) => {
  const n = model.nodeById.get(id);
  if (!n) return;
  n._userHidden = true;
  ctx.hidden.add(id);
  if (ctx.modals && ctx.modals.isOpen(id)) ctx.modals.closeModal(id);
  ctx.graph.updateVisibility();
  ctx.refLayer && ctx.refLayer.refreshRelations();
  ctx.renderHidden && ctx.renderHidden();
};
ctx.unhideNode = (id) => {
  const n = model.nodeById.get(id);
  if (!n) return;
  n._userHidden = false;
  ctx.hidden.delete(id);
  ctx.graph.updateVisibility();
  ctx.renderHidden && ctx.renderHidden();
};

const graph = new ForceGraph(model, {
  stageEl,
  svgEl,
  nodesEl,
  overlayEl,
  onNodeActivate: (n) => ctx.modals.openFromNode(n),
});
ctx.graph = graph;
graph.ctx = ctx;

ctx.modals = new ModalManager(ctx, { overlayEl, stageEl });
ctx.refLayer = new RefLayer(ctx, { overlayEl, stageEl });

// 节点 hover -> 邻居高亮 + 完整信息预览
graph.nodeEls.forEach((el, id) => {
  el.addEventListener('mouseenter', () => {
    if (ctx.mode !== 'show-modals-only') graph.highlightNeighbors(id, true);
    ctx.refLayer.highlightModal(id, true);
    ctx.refLayer.showNodePreview(el, ctx.model.nodeById.get(id));
  });
  el.addEventListener('mouseleave', () => {
    graph.highlightNeighbors(id, false);
    ctx.refLayer.highlightModal(id, false);
    ctx.refLayer.scheduleNodePreviewClose();
  });
});

// ---- 视图模式切换 ----
ctx.setMode = (key) => {
  ctx.mode = key;
  graph.setMode(key);
  ctx.modals.onModeChange(key);
  ctx.syncModeButtons && ctx.syncModeButtons();
  ctx.writeHash && ctx.writeHash();
};

buildSidebar(ctx, document.getElementById('sidebar'));
buildZoomControl(ctx, stageEl);

// ---- Deep-link：URL hash 恢复 / 写回 ----
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return {
    open: (h.get('open') || '').split(',').map((s) => s.trim()).filter(Boolean),
    mode: h.get('mode') || 'show-all',
    focus: h.get('focus') || '',
  };
}
ctx.writeHash = () => {
  const ids = [...ctx.modals.open.keys()];
  const params = new URLSearchParams();
  if (ids.length) params.set('open', ids.join(','));
  if (ctx.mode !== 'show-all') params.set('mode', ctx.mode);
  const str = params.toString();
  history.replaceState(null, '', str ? `#${str}` : location.pathname + location.search);
};

const state = readHash();
// 等首帧布局后再恢复，保证坐标可用
setTimeout(() => {
  if (state.open.length) {
    state.open.forEach((id, i) => {
      const n = model.nodeById.get(id);
      if (n) ctx.modals.openFromNode(n, { x: (i - (state.open.length - 1) / 2) * 460, y: 0 });
    });
    if (state.open.length === 1) graph.focusNode(state.open[0], 0.85);
  }
  if (state.mode && state.mode !== 'show-all' && ctx.setMode) ctx.setMode(state.mode);
  if (state.focus) graph.focusNode(state.focus, 1.0);
}, 700);

// ---- 公式预渲染（P10），带内存上限 ----
const RENDER_CACHE_LIMIT = 80; // 缓存条目上限（statement/proof 各算一条）
ctx.renderCache = new Map();
ctx.getRendered = (nodeId, which) => {
  const key = `${nodeId}::${which}`;
  if (ctx.renderCache.has(key)) {
    // LRU：命中后移到末尾
    const v = ctx.renderCache.get(key);
    ctx.renderCache.delete(key);
    ctx.renderCache.set(key, v);
    return v;
  }
  const node = model.nodeById.get(nodeId);
  if (!node) return '';
  const body = which === 'proof' ? node.proofBody : node.statementBody;
  const html = body ? render(body) : '';
  ctx.renderCache.set(key, html);
  // 超限则淘汰最旧
  while (ctx.renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = ctx.renderCache.keys().next().value;
    ctx.renderCache.delete(oldest);
  }
  return html;
};

// 空闲时间分批预渲染（statement 优先，再 proof）
function schedulePrerender() {
  const tasks = [];
  for (const n of model.nodes) {
    if (isLeafNode(model, n)) continue;
    if (n.statementBody) tasks.push([n.id, 'statement']);
  }
  for (const n of model.nodes) {
    if (isLeafNode(model, n)) continue;
    if (n.proofBody) tasks.push([n.id, 'proof']);
  }
  let i = 0;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 60));
  const step = (deadline) => {
    while (i < tasks.length && (!deadline || deadline.timeRemaining() > 4)) {
      const [id, which] = tasks[i++];
      ctx.getRendered(id, which);
    }
    if (i < tasks.length) idle(step);
  };
  idle(step);
}
setTimeout(schedulePrerender, 1500);

// 暴露调试
window.__ctx = ctx;
