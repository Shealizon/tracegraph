// =============================================================================
// main.js  —  项目入口、leading/main 路由与关系图状态机
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
import { renderLeadingPage } from './view/leadingPage.js';
import { initProjectStore, saveProject, setCurrentProjectId } from './project/store.js';
import { compileProject } from './project/projectAdapter.js';
import { downloadProject, goLeading, importFixedTex, importGenericTex, importStructuredJson, openProjectConfigDialog } from './project/projectConfig.js';

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:24px;color:#d66">启动失败：${escapeHtml(err?.message || err)}</pre>`;
});

async function init() {
  const store = await initProjectStore();
  const query = new URLSearchParams(location.search);
  const screen = query.get('screen') || 'leading';
  const projectId = query.get('project') || store.currentProjectId;

  if (screen === 'main') {
    const project = store.projects.find((p) => p.id === projectId) || store.projects[0];
    if (project) {
      setCurrentProjectId(project.id);
      if (!location.hash && project.config?.viewState?.hash) {
        history.replaceState(null, '', `${location.pathname}?screen=main&project=${encodeURIComponent(project.id)}${project.config.viewState.hash}`);
      }
      startMain(store.db, project);
    } else {
      renderLeadingPage(store);
    }
  } else {
    renderLeadingPage(store);
  }
}

function startMain(db, project) {
  document.getElementById('leading-root')?.remove();
  document.getElementById('app').style.display = 'block';

  const model = buildModel(compileProject(project));
  const initialState = readHash();

  // 渲染器：label -> 编号 / 类型 / 归属节点
  const labelEntryOf = (key) => {
    const direct = model.labelIndex.get(key);
    if (direct) return direct;
    const alias = model.meta?.labelAliases?.[key];
    return alias ? model.labelIndex.get(alias.labelId) : null;
  };
  const numberOf = (key) => labelEntryOf(key)?.label.number ?? (model.meta?.bib?.[key] ?? '?');
  const kindOf = (key) => labelEntryOf(key)?.label.kind ?? model.meta.profileResolved?.defaultType ?? 'theorem';
  const ownerOf = (key) => labelEntryOf(key)?.node.id ?? null;
  const render = createRenderer({ macros: model.meta.macros, numberOf, kindOf, ownerOf });

  const stageEl = document.getElementById('stage');
  const svgEl = document.getElementById('edges-layer');
  const nodesEl = document.getElementById('nodes-layer');
  const overlayEl = document.getElementById('overlay-layer');
  svgEl.innerHTML = '';
  nodesEl.innerHTML = '';
  overlayEl.innerHTML = '';

  let saveTimer = null;
  const scheduleProjectStateSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const next = {
        ...project,
        config: {
          ...project.config,
          viewState: { ...(project.config?.viewState || {}), hash: location.hash || '' },
        },
      };
      saveProject(db, next).catch((err) => console.warn('failed to save project view state', err));
    }, 350);
  };

  // ---- 应用上下文（供各模块共享） ----
  const ctx = {
    db,
    project,
    model,
    render,
    numberOf,
    kindOf,
    ownerOf,
    graph: null,
    modals: null,
    refLayer: null,
    mode: initialState.mode || 'show-all',
    refsRaiseEnabled: initialState.refsRaiseEnabled ?? (localStorage.getItem('hg-refs-raise') !== '0'),
    // 主题模式：dark | light | system（跟随系统）
    themeMode: initialState.themeMode || localStorage.getItem('hg-theme-mode') || localStorage.getItem('hg-theme') || 'system',
    theme: 'dark',
    hidden: new Set(initialState.hidden),
    filterActive: initialState.types ? new Set(initialState.types) : null,
    sidebarCollapsed: initialState.sidebarCollapsed,
    openDetails: (nodeId) => openDetails(ctx, nodeId),
    goLeading,
    openProjectConfig: () => openProjectConfigDialog({ db, project, onSaved: () => location.reload() }),
    exportProject: () => downloadProject(project),
    importFile: async () => {
      const kind = prompt('导入类型：json / tex（通用·自动识别）/ tex-fixed（固定格式）', 'json');
      if (!kind) return;
      const k = kind.toLowerCase().trim();
      if (k === 'json') await importStructuredJson(db, project);
      else if (k === 'tex-fixed' || k === 'fixed') await importFixedTex(db, project);
      else if (k === 'tex' || k === 'generic') await importGenericTex(db, project);
      else { alert('PDF 本地解析仍在开发中（将在浏览器内提取文字层并做结构识别）。当前可用 json / tex 导入。'); return; }
      location.reload();
    },
  };

  for (const id of ctx.hidden) {
    const n = model.nodeById.get(id);
    if (n) n._userHidden = true;
  }

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
    ctx.writeHash && ctx.writeHash();
  };
  systemMql.addEventListener('change', () => { if (ctx.themeMode === 'system') { ctx.applyTheme(); ctx.syncThemeButtons && ctx.syncThemeButtons(); } });
  // 兼容旧的 setTheme 调用：直接当作选定具体主题
  ctx.setTheme = (t) => ctx.setThemeMode(t);
  ctx.applyTheme();

  // ---- 结构操作撤销栈（N7）：展开/折叠卡片、隐藏/取消隐藏、pin、关闭全部、重新布局 ----
  ctx.undoStack = [];
  ctx._undoing = false;
  ctx._restoring = false;
  ctx.pushUndo = (entry) => {
    if (ctx._undoing || ctx._restoring || !entry || !entry.undo) return;
    ctx.undoStack.push(entry);
    if (ctx.undoStack.length > 120) ctx.undoStack.shift();
  };
  ctx.undo = () => {
    const entry = ctx.undoStack.pop();
    if (!entry) return;
    ctx._undoing = true;
    try { entry.undo(); } catch (err) { console.warn('undo failed', err); }
    finally { ctx._undoing = false; }
  };
  // 重新布局（可撤销）：先快照当前坐标，撤销时原样还原
  ctx.relayout = () => {
    const snap = model.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, fx: n.fx, fy: n.fy }));
    ctx.pushUndo({ undo: () => {
      for (const s of snap) { const n = model.nodeById.get(s.id); if (!n) continue; n.x = s.x; n.y = s.y; n.fx = s.fx; n.fy = s.fy; }
      ctx.graph.sim.alpha(0);
      ctx.graph._tick();
      ctx.modals && ctx.modals._syncPositions && ctx.modals._syncPositions();
    } });
    ctx.graph.reheat(0.8);
  };

  // ---- 隐藏节点管理（P8） ----
  ctx.hideNode = (id) => {
    const n = model.nodeById.get(id);
    if (!n) return;
    ctx.pushUndo({ undo: () => ctx.unhideNode(id) });
    n._userHidden = true;
    ctx.hidden.add(id);
    if (ctx.modals && ctx.modals.isOpen(id)) ctx.modals.closeModal(id);
    ctx.graph.updateVisibility();
    ctx.refLayer && ctx.refLayer.refreshRelations();
    ctx.renderHidden && ctx.renderHidden();
    ctx.writeHash && ctx.writeHash();
  };
  ctx.unhideNode = (id) => {
    const n = model.nodeById.get(id);
    if (!n) return;
    ctx.pushUndo({ undo: () => ctx.hideNode(id) });
    n._userHidden = false;
    ctx.hidden.delete(id);
    ctx.graph.updateVisibility();
    ctx.renderHidden && ctx.renderHidden();
    ctx.writeHash && ctx.writeHash();
  };

  const graph = new ForceGraph(model, {
    stageEl,
    svgEl,
    nodesEl,
    overlayEl,
    storageKey: `hg-pos-${project.id}`,
    onNodeActivate: (n) => ctx.modals.openFromNode(n),
  });
  ctx.graph = graph;
  graph.ctx = ctx;
  if (initialState.force) {
    if (Number.isFinite(initialState.force.center)) graph.setForce('center', initialState.force.center);
    if (Number.isFinite(initialState.force.charge)) graph.setForce('charge', initialState.force.charge);
    if (Number.isFinite(initialState.force.link)) graph.setForce('link', initialState.force.link);
  }

  ctx.modals = new ModalManager(ctx, { overlayEl, stageEl });
  ctx.refLayer = new RefLayer(ctx, { overlayEl, stageEl });
  if (Number.isFinite(initialState.modalWidth)) ctx.modals.setWidth(initialState.modalWidth);

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
  if (ctx.mode !== 'show-all') {
    graph.setMode(ctx.mode);
    ctx.modals.onModeChange(ctx.mode);
  }

  buildSidebar(ctx, document.getElementById('sidebar'));
  buildZoomControl(ctx, stageEl);

  // ---- Deep-link：URL hash 恢复 / 写回 ----
  ctx.writeHash = () => {
    const ids = ctx.modals ? [...ctx.modals.open.keys()] : [];
    const params = new URLSearchParams();
    if (ids.length) params.set('open', ids.join(','));
    params.set('mode', ctx.mode);
    if (ctx.filterActive) params.set('types', [...ctx.filterActive].join(','));
    params.set('hidden', [...(ctx.hidden || [])].join(','));
    if (ctx.graph) params.set('force', ['center', 'charge', 'link'].map((k) => fmtNumber(ctx.graph.getForce(k))).join(','));
    if (ctx.modals) params.set('modal', String(ctx.modals.getWidth()));
    params.set('refs', ctx.refsRaiseEnabled ? '1' : '0');
    params.set('theme', ctx.themeMode);
    params.set('sidebar', ctx.sidebarCollapsed ? '0' : '1');
    const str = params.toString();
    history.replaceState(null, '', `${location.pathname}?screen=main&project=${encodeURIComponent(project.id)}${str ? `#${str}` : ''}`);
    scheduleProjectStateSave();
  };

  const state = initialState;
  // 等首帧布局后再恢复，保证坐标可用（恢复期间不记录撤销）
  ctx._restoring = true;
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
    ctx.writeHash && ctx.writeHash();
    ctx._restoring = false;
  }, 700);

  // ---- 结构操作撤销：Ctrl+Z / Cmd+Z（N7） ----
  window.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return;
    if (ev.key !== 'z' && ev.key !== 'Z') return;
    const t = ev.target;
    const tag = (t && t.tagName) || '';
    if (/^(INPUT|TEXTAREA)$/.test(tag) || (t && t.isContentEditable)) return;
    ev.preventDefault();
    ctx.undo();
  });

  // ---- 按住 Alt：全屏平移 / 强制缩放手势的光标反馈 + 悬停不变灰（PR2） ----
  const appEl = document.getElementById('app');
  const reEvalHover = () => { if (ctx.graph && ctx.graph._hoverId) ctx.graph.highlightNeighbors(ctx.graph._hoverId, true); };
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Alt') { appEl.classList.add('alt-pan'); reEvalHover(); } });
  window.addEventListener('keyup', (ev) => { if (ev.key === 'Alt') { appEl.classList.remove('alt-pan'); reEvalHover(); } });
  window.addEventListener('blur', () => { appEl.classList.remove('alt-pan'); reEvalHover(); });

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
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const forceParts = (h.get('force') || '').split(',').map((v) => Number(v));
  return {
    open: parseList(h.get('open')),
    mode: h.get('mode') || 'show-all',
    focus: h.get('focus') || '',
    types: h.has('types') ? parseList(h.get('types')) : null,
    hidden: parseList(h.get('hidden')),
    force: h.has('force') ? { center: forceParts[0], charge: forceParts[1], link: forceParts[2] } : null,
    modalWidth: h.has('modal') ? Number(h.get('modal')) : null,
    refsRaiseEnabled: h.has('refs') ? h.get('refs') !== '0' : null,
    themeMode: h.get('theme') || '',
    sidebarCollapsed: h.has('sidebar') ? h.get('sidebar') === '0' : null,
  };
}

function parseList(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function fmtNumber(value) {
  return Number(value).toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
