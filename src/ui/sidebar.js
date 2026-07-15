// =============================================================================
// ui/sidebar.js  —  侧栏（统一控件 · 可折叠分区）
// =============================================================================
import { ICON } from './icons.js';
import { nodeTag, typeColor, TAG_COLORS, isLeafNode, memberNode, memberType, memberKey } from '../data/schema.js';
import { confirmDialog, toast } from './feedback.js';
import { buildModalShell } from '../view/modal.js';
import { annotationRectsFromRange, groupAnnotationRects } from '../view/annotation.js';
import { renderMarkdownInto } from '../render/markdown.js';
import { graphReferenceToMember, noteReferenceFromNote, resolveTagNoteReference } from '../data/graphReference.js';
import { bindGraphReferencePaste, writeGraphReference, writePlainText } from './graphClipboard.js';
import { floatingNotes, noteDisplayTitle, notePointerFromMember, removeNote, resolveNotePointer, upsertNote } from '../data/notes.js';
import { createNoteRow } from './noteUi.js';

const THEME_MODES = [
  { mode: 'dark', icon: 'moon', title: '深色' },
  { mode: 'system', icon: 'monitor', title: '跟随系统' },
  { mode: 'light', icon: 'sun', title: '浅色' },
];
const CHEVRON ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export function buildSidebar(ctx, root) {
  root.innerHTML = '';
  const { model, graph } = ctx;
  ctx.openNoteEditor = (noteId = '', options = {}) => openNoteEditor(ctx, noteId, options);
  ctx.openTagNoteEditor = (tagId, options = {}) => openTagNoteEditor(ctx, tagId, options);
  const app = document.getElementById('app');
  const rail = ensureCollapseRail(app);
  const mobileSidebar = ensureMobileSidebarToggle(app);
  const collapsed = ctx.sidebarCollapsed ?? (localStorage.getItem('hg-sidebar-collapsed') === '1');
  const setCollapsed = (on) => {
    ctx.sidebarCollapsed = on;
    app.classList.toggle('sidebar-collapsed', on);
    localStorage.setItem('hg-sidebar-collapsed', on ? '1' : '0');
    rail.title = on ? '展开侧栏' : '折叠侧栏';
    ctx.writeHash && ctx.writeHash();
  };
  ctx.setSidebarCollapsed = setCollapsed;
  ctx.revealSidebarNote = (noteId) => {
    setCollapsed(false);
    if (window.matchMedia?.('(max-width: 760px)').matches) app.classList.add('mobile-sidebar-open');
    requestAnimationFrame(() => requestAnimationFrame(() => highlightSidebarNote(root, noteId)));
  };
  rail.onclick = () => setCollapsed(!app.classList.contains('sidebar-collapsed'));
  mobileSidebar.button.onclick = () => app.classList.toggle('mobile-sidebar-open');
  mobileSidebar.backdrop.onclick = () => app.classList.remove('mobile-sidebar-open');
  setCollapsed(collapsed);

  // ---- 头部：返回首页 · 项目名 · 溢出菜单 ----
  const head = el('div', 'side-head');
  const homeBtn = iconBtn('返回项目首页', 'home', () => ctx.goLeading && ctx.goLeading());
  const titleWrap = el('div', 'side-head-text');
  const locationLabel = projectLocationLabel(ctx.project, ctx.cloud?.user);
  titleWrap.innerHTML = `<div class="side-title">${escapeHtml(model.meta.title || '关系图')}</div><div class="side-sub">${model.meta.counts.statements} 节点 · ${model.meta.counts.edges} 关系${model.hasCycle ? ' · 含环' : ''}<span class="side-cloud-state">${locationLabel}</span></div>`;
  const moreBtn = iconBtn('更多操作', 'more', null);
  head.appendChild(homeBtn);
  head.appendChild(titleWrap);
  head.appendChild(moreBtn);
  root.appendChild(head);
  attachOverflowMenu(ctx, moreBtn);

  // 主题分段开关（单独成行）
  const themeRow = el('div', 'side-tools');
  themeRow.appendChild(buildThemeSwitch(ctx));
  root.appendChild(themeRow);

  // ---- 搜索（无标签，placeholder 已说明；与主题按钮留间距） ----
  const grpSearch = el('div', 'side-group side-group--search');
  root.appendChild(grpSearch);
  const searchBox = el('div', 'side-search-box');
  searchBox.innerHTML = `<span class="side-search-ico">${ICON.search}</span>`;
  const input = el('input', 'side-search');
  input.placeholder = '搜索';
  searchBox.appendChild(input);
  grpSearch.appendChild(searchBox);
  const results = el('div', 'search-results');
  grpSearch.appendChild(results);
  input.addEventListener('input', () => renderSearch(ctx, input.value, results));

  // ---- 视图 ----
  const grpMode = group(root, '视图');
  const modeSet = el('div', 'segmented');
  const modeBtns = {};
  for (const [key, label] of [['show-all', '显示全部节点'], ['show-modals-only', '仅显示卡片']]) {
    const b = el('button', 'seg');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('active', ctx.mode === key);
    b.addEventListener('click', () => ctx.setMode(key));
    modeBtns[key] = b;
    modeSet.appendChild(b);
  }
  grpMode.appendChild(modeSet);
  ctx.syncModeButtons = () => Object.entries(modeBtns).forEach(([k, e]) => e.classList.toggle('active', k === ctx.mode));

  const raise = toggleRow('引用连线高亮', ctx.refsRaiseEnabled, () => {
    ctx.refsRaiseEnabled = !ctx.refsRaiseEnabled;
    localStorage.setItem('hg-refs-raise', ctx.refsRaiseEnabled ? '1' : '0');
    raise.set(ctx.refsRaiseEnabled);
    ctx.refLayer.setRaiseEnabled(ctx.refsRaiseEnabled);
    ctx.writeHash && ctx.writeHash();
  });
  raise.row.title = '高亮引用连线';
  grpMode.appendChild(raise.row);

  const actions = el('div', 'side-actions');
  actions.appendChild(btn('所有卡片关闭为节点', () => ctx.modals.closeAll()));
  const actionRow = el('div', 'side-actions-row');
  actionRow.appendChild(btn('所有卡片折叠细节', () => ctx.modals.collapseAllProofs()));
  actionRow.appendChild(btn('重新布局', () => (ctx.relayout ? ctx.relayout() : graph.reheat(0.8)), 'reload'));
  actions.appendChild(actionRow);
  const actionRow2 = el('div', 'side-actions-row');
  actionRow2.appendChild(btn('取消所有固定', () => ctx.graph.unpinAll()));
  actions.appendChild(actionRow2);
  grpMode.appendChild(actions);

  // ---- 筛选 ----
  // 多篇：每篇论文作为一级折叠文件夹，其出现的类型置于其下，论文可一键显示/隐藏
  // 单篇：直接平铺类型开关
  const docs = model.meta.documents || [];
  ctx._multiDoc = docs.length > 1;
  const profileLabel = new Map((model.meta.profileResolved?.types || []).map((t) => [t.id, t.label || t.id]));
  // 筛选键：单篇用 type；多篇用 docId::type（每篇的同类型可独立开关）
  const allKeys = new Set(model.nodes.map((n) => filterKeyFor(ctx, n)));
  ctx.filterActive = ctx.filterActive || new Set(allKeys);
  // 兼容旧链接/键格式变化：现有筛选键与当前完全不匹配时，视为全选
  if (![...ctx.filterActive].some((k) => allKeys.has(k))) ctx.filterActive = new Set(allKeys);

  const grpFilter = group(root, '筛选');
  if (ctx._multiDoc) {
    docs.forEach((d) => {
      const present = [...new Set(model.nodes.filter((n) => n.documentId === d.id).map((n) => n.type))];
      if (present.length) buildPaperFolder(grpFilter, ctx, d, present.map((t) => [t, profileLabel.get(t) || t]));
    });
  } else {
    const present = [...new Set(model.nodes.map((n) => n.type))];
    for (const t of present) {
      const tr = toggleRow(escapeHtml(profileLabel.get(t) || t), ctx.filterActive.has(t), () => {
        toggleFilterKey(ctx, t); tr.set(ctx.filterActive.has(t)); applyFilter(ctx); ctx.writeHash && ctx.writeHash();
      }, typeColor(model, t));
      grpFilter.appendChild(tr.row);
    }
  }

  // ---- 标签（主线/有序 + 无序）----
  ctx.applyTagFilter = () => applyFilter(ctx);
  const grpTags = group(root, '标签');
  const tagBody = el('div', 'tag-panel');
  grpTags.appendChild(tagBody);
  const grpNotes = group(root, '笔记');
  const noteBody = el('div', 'floating-notes-panel');
  grpNotes.appendChild(noteBody);
  ctx.rebuildTagPanel = () => { renderTagPanel(ctx, tagBody); renderFloatingNotes(ctx, noteBody); };
  ctx.rebuildTagPanel();

  // ---- 已隐藏（仅在有内容时展开） ----
  const hasHidden = (ctx.hidden && ctx.hidden.size > 0);
  const grpHidden = section(root, '已隐藏', 'hidden', !hasHidden);
  const hiddenList = el('div', 'hidden-list');
  grpHidden.appendChild(hiddenList);
  ctx.renderHidden = () => renderHidden(ctx, hiddenList);

  // ---- 高级（默认折叠）：布局力度 + 显示 ----
  const grpAdv = section(root, '高级', 'advanced', true);
  grpAdv.appendChild(subLabel('布局力度'));
  grpAdv.appendChild(slider('聚拢力', 0, 1, 0.01, graph.getForce('center'), (v) => { graph.setForce('center', v); ctx.writeHash && ctx.writeHash(); }));
  grpAdv.appendChild(slider('排斥力', 80, 1600, 20, graph.getForce('charge'), (v) => { graph.setForce('charge', v); ctx.writeHash && ctx.writeHash(); }));
  grpAdv.appendChild(slider('连线吸引', 0, 1, 0.02, graph.getForce('link'), (v) => { graph.setForce('link', v); ctx.writeHash && ctx.writeHash(); }));
  grpAdv.appendChild(subLabel('显示'));
  grpAdv.appendChild(slider('卡片宽度', 280, 620, 10, ctx.modals.getWidth(), (v) => { ctx.modals.setWidth(v); ctx.writeHash && ctx.writeHash(); }, 'px'));
  grpAdv.appendChild(slider('箭头粗细', 1, 4, 0.1, graph.getEdgeWidth(), (v) => { graph.setEdgeWidth(v); ctx.writeHash && ctx.writeHash(); }, '×'));

  applyFilter(ctx);
  ctx.renderHidden();
}

// ---- 溢出菜单：项目配置 / 导入文件 / 导出项目 ----
function attachOverflowMenu(ctx, anchor) {
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', onDoc, true); } };
  const onDoc = (ev) => { if (menu && !menu.contains(ev.target) && ev.target !== anchor) close(); };
  const items = [
    { label: '阅读列表', icon: 'search', run: () => ctx.openReaderLibrary && ctx.openReaderLibrary() },
    { label: '项目配置', icon: 'settings', run: () => ctx.openProjectConfig && ctx.openProjectConfig() },
    { label: '导入文件', icon: 'upload', run: () => ctx.importFile && ctx.importFile() },
    { label: '导出项目', icon: 'download', run: () => ctx.exportProject && ctx.exportProject() },
  ];
  anchor.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menu) { close(); return; }
    menu = el('div', 'side-menu');
    for (const it of items) {
      const mi = el('button', 'side-menu-item');
      mi.type = 'button';
      mi.innerHTML = `${ICON[it.icon] || ''}<span>${it.label}</span>`;
      mi.addEventListener('click', () => { close(); it.run(); });
      menu.appendChild(mi);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, r.right - 168)}px`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  });
}

// 三态主题分段开关：深色 / 跟随系统 / 浅色
function buildThemeSwitch(ctx) {
  const wrap = el('div', 'segmented theme-seg-group');
  wrap.setAttribute('role', 'radiogroup');
  const btns = {};
  for (const { mode, icon, title } of THEME_MODES) {
    const b = el('button', 'seg');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = ICON[icon] || '';
    b.addEventListener('click', () => ctx.setThemeMode(mode));
    btns[mode] = b;
    wrap.appendChild(b);
  }
  ctx.syncThemeButtons = () => {
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
  val.title = '恢复 100%';
  val.addEventListener('click', () => ctx.graph.setZoomScale(1));
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '10';
  input.max = '260';
  input.step = '1';
  input.className = 'slider zoom-slider';
  const home = el('button', 'zoom-home');
  home.innerHTML = ICON.home;
  home.title = '适应视图';
  home.addEventListener('click', () => ctx.graph.fitView(0.8));
  const lock = el('button', 'zoom-lock');
  lock.innerHTML = LOCK;
  lock.title = '锁定缩放';
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
  top.appendChild(home);
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
  b.innerHTML = `<span class="rail-ico">${CHEVRON}</span>`;
  return b;
}

function ensureMobileSidebarToggle(app) {
  let button = app.querySelector('.mobile-sidebar-toggle');
  if (!button) {
    button = el('button', 'mobile-sidebar-toggle');
    button.type = 'button';
    app.appendChild(button);
  }
  button.innerHTML = ICON.settings;
  button.title = '显示侧栏';
  button.setAttribute('aria-label', '显示侧栏');

  let backdrop = app.querySelector('.mobile-sidebar-backdrop');
  if (!backdrop) {
    backdrop = el('button', 'mobile-sidebar-backdrop');
    backdrop.type = 'button';
    backdrop.setAttribute('aria-label', '关闭侧栏');
    app.appendChild(backdrop);
  }
  return { button, backdrop };
}

// 节点对应的筛选键：单篇=type，多篇=docId::type
function filterKeyFor(ctx, n) {
  return ctx._multiDoc ? `${n.documentId}::${n.type}` : n.type;
}
function toggleFilterKey(ctx, key) {
  if (ctx.filterActive.has(key)) ctx.filterActive.delete(key); else ctx.filterActive.add(key);
}

// 论文文件夹：折叠头（caret + 论文名 + 一键显隐）+ 该篇类型开关列表
function buildPaperFolder(parent, ctx, doc, typeList) {
  const { model } = ctx;
  const keysOf = typeList.map(([t]) => `${doc.id}::${t}`);
  const g = el('div', 'side-group disclosure filter-paper');
  const stored = localStorage.getItem(`hg-paperfolder-${doc.id}`);
  g.classList.toggle('collapsed', stored === '1');

  const head = el('div', 'disc-head paper-head');
  head.innerHTML = `<span class="disc-caret">${ICON.chevronDown}</span><span class="paper-name">${escapeHtml(doc.name)}</span>`;
  head.title = doc.name;
  head.addEventListener('click', () => {
    const now = g.classList.toggle('collapsed');
    localStorage.setItem(`hg-paperfolder-${doc.id}`, now ? '1' : '0');
  });

  // 一键显示/隐藏整篇
  const master = el('button', 'paper-master');
  master.type = 'button';
  const rows = [];
  const syncMaster = () => {
    const on = keysOf.filter((k) => ctx.filterActive.has(k)).length;
    const full = on === keysOf.length, none = on === 0;
    master.classList.toggle('on', full);
    master.classList.toggle('off', none);
    master.classList.toggle('partial', !full && !none);
    master.title = full ? '隐藏整篇' : '显示整篇';
    master.innerHTML = none ? ICON.eyeOff : ICON.check;
  };
  master.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const allOn = keysOf.every((k) => ctx.filterActive.has(k));
    keysOf.forEach((k) => { if (allOn) ctx.filterActive.delete(k); else ctx.filterActive.add(k); });
    rows.forEach((r) => r.sync());
    syncMaster();
    applyFilter(ctx);
    ctx.writeHash && ctx.writeHash();
  });
  head.appendChild(master);

  const body = el('div', 'disc-body');
  for (const [t, label] of typeList) {
    const key = `${doc.id}::${t}`;
    const tr = toggleRow(escapeHtml(label), ctx.filterActive.has(key), () => {
      toggleFilterKey(ctx, key); tr.set(ctx.filterActive.has(key)); syncMaster(); applyFilter(ctx); ctx.writeHash && ctx.writeHash();
    }, typeColor(model, t));
    tr.sync = () => tr.set(ctx.filterActive.has(key));
    rows.push(tr);
    body.appendChild(tr.row);
  }
  syncMaster();
  g.appendChild(head);
  g.appendChild(body);
  parent.appendChild(g);
}

function applyFilter(ctx) {
  const { graph, model } = ctx;
  // 标签筛选：若启用了「仅看此标签」，只保留这些标签成员的并集
  let tagMembers = null;
  if (ctx.tagFilter && ctx.tagFilter.size) {
    tagMembers = new Set();
    for (const t of (graph.getTags ? graph.getTags() : [])) {
      if (ctx.tagFilter.has(t.id)) for (const m of t.members) tagMembers.add(memberNode(m));
    }
  }
  for (const n of model.nodes) {
    const typeHidden = !ctx.filterActive.has(filterKeyFor(ctx, n));
    const tagHidden = tagMembers ? !tagMembers.has(n.id) : false;
    n._hidden = typeHidden || tagHidden;
  }
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
    item.innerHTML = `<span class="hidden-item-label">${tag} · ${escapeHtml(n.title || n.id)}</span><span class="x">↺</span>`;
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

// ---- 标签面板 ----
function renderTagPanel(ctx, body) {
  closeTagMemberPreview(ctx, true);
  body.innerHTML = '';
  const tags = ctx.graph.getTags ? ctx.graph.getTags() : [];
  ctx.tagFilter = ctx.tagFilter || new Set();
  if (!tags.length) { const e = el('div', 'tag-empty'); e.textContent = '暂无标签。新建后点「打标」选节点。'; body.appendChild(e); }
  tags.forEach((tag) => body.appendChild(buildTagRow(ctx, tag)));

  const add = el('div', 'side-actions-row');
  add.appendChild(btn('+ 有序', () => createTag(ctx, 'ordered')));
  add.appendChild(btn('+ 无序', () => createTag(ctx, 'unordered')));
  body.appendChild(add);
}

function renderFloatingNotes(ctx, body) {
  body.replaceChildren();
  const loose = floatingNotes(ctx.getNotes?.() || []);
  const looseSection = el('div', 'floating-notes-section');
  const looseHead = el('div', 'floating-notes-head');
  const looseLabel = el('span', 'floating-notes-label'); looseLabel.innerHTML = `${ICON.note}<span>游离笔记 · ${loose.length}</span>`;
  looseHead.append(looseLabel, mkIc('plus', '添加游离笔记', (event) => ctx.openNoteEditor?.('', { tagPointer: null, anchor: event.currentTarget })));
  looseSection.appendChild(looseHead);
  const looseList = el('div', 'floating-notes-list');
  if (!loose.length) { const empty = el('div', 'tag-note-empty'); empty.textContent = '暂无游离笔记'; looseList.appendChild(empty); }
  loose.forEach((note) => looseList.appendChild(createNoteRow(ctx, note, { className: 'sidebar-note-row' })));
  looseSection.appendChild(looseList);
  body.appendChild(looseSection);
}

export function highlightSidebarNote(root, noteId) {
  const row = [...(root?.querySelectorAll?.('.note-ui-row[data-note-id]') || [])]
    .find((element) => element.dataset.noteId === String(noteId));
  if (!row) return null;
  row.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  row.classList.remove('is-note-revealed');
  void row.offsetWidth;
  row.classList.add('is-note-revealed');
  setTimeout(() => row.classList.remove('is-note-revealed'), 2200);
  return row;
}

function buildTagRow(ctx, tag) {
  const box = el('div', 'tag-box');
  box.style.setProperty('--tc', tag.color || '#ff9e64');
  const row = el('div', 'tag-row');
  if (tag.visible === false) row.classList.add('tag-vis-off');
  if (ctx.tagEditing === tag.id) row.classList.add('tag-editing');

  ctx._tagExpanded = ctx._tagExpanded || new Set();
  const expanded = ctx._tagExpanded.has(tag.id);
  const caret = mkIc('chevronDown', expanded ? '收起' : '展开', () => {
    if (ctx._tagExpanded.has(tag.id)) ctx._tagExpanded.delete(tag.id); else ctx._tagExpanded.add(tag.id);
    ctx.rebuildTagPanel();
  });
  caret.classList.add('tag-caret');
  if (expanded) caret.classList.add('open');

  // 色块（有序=方框 / 无序=圆点）兼显隐开关：点击切换可见，隐藏时变灰 + 划线
  const hidden = tag.visible === false;
  const swatch = el('button', `tag-swatch${tag.kind === 'ordered' ? ' square' : ''}${hidden ? ' off' : ''}`);
  swatch.style.background = hidden ? '' : tag.color;
  swatch.title = hidden ? '显示' : '隐藏';
  swatch.addEventListener('click', (e) => { e.stopPropagation(); ctx.persistTags(ctx.graph.getTags().map((t) => (t.id === tag.id ? { ...t, visible: hidden } : t))); });

  const name = el('div', 'tag-name');
  const label = el('span', 'tag-label' + (tag.label ? '' : ' empty')); label.textContent = tag.label; label.title = '双击重命名';
  label.addEventListener('dblclick', (e) => { e.stopPropagation(); startInlineEdit(ctx, label, tag.label, (v) => ctx.persistTags(ctx.graph.getTags().map((t) => (t.id === tag.id ? { ...t, label: v } : t)))); });
  name.appendChild(swatch); name.appendChild(label);

  const filterOn = ctx.tagFilter.has(tag.id);
  const filt = mkIc('search', filterOn ? '取消筛选' : '筛选', () => {
    if (ctx.tagFilter.has(tag.id)) ctx.tagFilter.delete(tag.id); else ctx.tagFilter.add(tag.id);
    ctx.applyTagFilter(); ctx.rebuildTagPanel();
  });
  if (filterOn) filt.classList.add('on');
  // 可成卡的成员（非叶子、在场）。全为卡片→显示「折叠为节点」圆点堆叠图标；否则→「打开为卡片」卡片堆叠图标
  const cardable = tag.members.map(memberNode).map((id) => ctx.model.nodeById.get(id)).filter((n) => n && !n._userHidden && !isLeafNode(ctx.model, n));
  const allCards = cardable.length > 0 && cardable.every((n) => n.isModal);
  const openClose = mkIc(allCards ? 'nodes' : 'cards', allCards ? '全部关闭为节点' : '全部打开为卡片', () => {
    if (allCards) cardable.forEach((n) => ctx.modals.closeModal(n.id));
    else cardable.forEach((n) => { if (!n.isModal) ctx.modals.openFromNode(n); });
    ctx.rebuildTagPanel();
  });

  const acts = el('div', 'tag-acts');
  acts.appendChild(openClose);
  acts.appendChild(filt);
  acts.appendChild(mkIc('route', '全览', () => ctx.graph.arrangeTag(tag.id)));

  row.appendChild(caret); row.appendChild(name); row.appendChild(acts);
  box.appendChild(row);

  // 展开：统计 + 添加成员 + 删除（红）一行，下接成员列表
  if (expanded) {
    const sub = el('div', 'tag-subrow');
    const stat = el('span', 'tag-stat'); stat.textContent = `${tag.kind === 'ordered' ? '有序' : '无序'} · ${tag.members.length}`;
    // 标记文字（图中贴片：有序=序号前缀，无序=图标后缀）；色框样式同成员标号；双击编辑
    const marker = el('span', 'tag-marker-field' + (tag.marker ? '' : ' empty'));
    marker.textContent = tag.marker || '标记';
    marker.title = '双击编辑标记';
    marker.addEventListener('dblclick', () => startInlineEdit(ctx, marker, tag.marker, (v) => ctx.persistTags(ctx.graph.getTags().map((t) => (t.id === tag.id ? { ...t, marker: v } : t)))));
    const editing = ctx.tagEditing === tag.id;
    const add = mkIc('plus', editing ? '完成' : '添加成员', () => ctx.setTagEditing(editing ? null : tag.id));
    if (editing) add.classList.add('on');
    const del = mkIc('trash', '删除', async () => {
      const ok = await confirmDialog({ title: '删除标签', message: `删除「${tag.label}」？仅移除标签，不影响节点。`, okText: '删除', danger: true });
      if (!ok) return;
      if (ctx.tagEditing === tag.id) ctx.setTagEditing(null);
      ctx.tagFilter.delete(tag.id);
      ctx.persistTags(ctx.graph.getTags().filter((t) => t.id !== tag.id));
    });
    del.classList.add('tag-del');
    sub.appendChild(stat);
    sub.appendChild(marker);
    sub.appendChild(el('span', 'tag-sub-gap'));
    sub.appendChild(add);
    sub.appendChild(del);
    box.appendChild(sub);
    box.appendChild(buildMemberList(ctx, tag));
  }
  return box;
}

// 通用内联编辑：把展示元素替换为输入框，Enter/失焦保存，Esc 取消（不用原生 prompt）
function startInlineEdit(ctx, displayEl, value, save) {
  const input = el('input', 'tag-edit-input');
  input.value = value || '';
  input.size = Math.max(4, (value || '').length + 2);
  displayEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (ok) => {
    if (done) return; done = true;
    if (ok) save(input.value.trim()); else ctx.rebuildTagPanel();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

// 成员列表：可删除、（有序）相邻间悬停显出「插入」长条，点击进入该处插入模式
function buildMemberList(ctx, tag) {
  const wrap = el('div', 'tag-members');
  const ordered = tag.kind === 'ordered';
  const mkInsert = (idx) => {
    if (!ordered) return null;
    const bar = el('button', 'tag-insert'); bar.type = 'button';
    bar.title = '在此插入';
    bar.innerHTML = '<span></span>';
    if (ctx.tagEditing === tag.id && ctx.tagInsertAt === idx) bar.classList.add('on');
    bar.addEventListener('click', () => ctx.setTagEditing(tag.id, idx));
    return bar;
  };
  if (ordered) { const b = mkInsert(0); if (b) wrap.appendChild(b); }
  tag.members.forEach((m, i) => {
    const mid = memberNode(m); const mt = memberType(m); const n = ctx.model.nodeById.get(mid); const mkey = memberKey(m);
    const mrow = el('div', 'tag-member');
    const lead = ordered ? `<span class="tm-idx">${i + 1}</span>` : `<span class="tm-mark">${ICON[tag.icon] || ICON.tag}</span>`;
    const kind = memberKindInfo(mt);
    mrow.innerHTML = `${lead}<span class="tm-label">${escapeHtml(n ? (n.title || n.id) : mid)}</span><span class="tm-type tm-type-${mt}" title="${kind.label}">${ICON[kind.icon]}</span>`;
    mrow.title = '点击定位；悬停预览';
    const notes = ctx.notesForMember?.(tag, m) || [];
    const notesKey = `${tag.id}:${mkey}`;
    const noteBtn = el('button', `tm-note-toggle${notes.length ? ' has-notes' : ''}`);
    noteBtn.type = 'button'; noteBtn.title = notes.length ? '展开笔记' : '添加笔记';
    noteBtn.innerHTML = `${ICON.note}${notes.length ? `<small>${notes.length}</small>` : ''}`;
    noteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!notes.length) { ctx.openNoteEditor?.('', { tagPointer: notePointerFromMember(tag, m), anchor: noteBtn }); return; }
      ctx._tagMemberNotesExpanded = ctx._tagMemberNotesExpanded || new Set();
      if (ctx._tagMemberNotesExpanded.has(notesKey)) ctx._tagMemberNotesExpanded.delete(notesKey); else ctx._tagMemberNotesExpanded.add(notesKey);
      ctx.rebuildTagPanel();
    });
    const del = el('button', 'tm-del'); del.type = 'button'; del.textContent = '×'; del.title = '移出';
    del.addEventListener('click', async (e) => { e.stopPropagation(); await ctx.requestDeleteTagMember?.(tag.id, m); });
    mrow.append(noteBtn, del);
    mrow.addEventListener('mouseenter', () => showTagMemberPreview(ctx, tag, m, n, mrow));
    mrow.addEventListener('mouseleave', () => closeTagMemberPreview(ctx));
    // 点击成员：节点聚焦；文本/位置成员同时滚动到精确锚点。
    mrow.addEventListener('click', () => {
      if (!n) return;
      closeTagMemberPreview(ctx, true);
      if (ctx.jumpToMember) ctx.jumpToMember(m);
    });
    wrap.appendChild(mrow);
    if (ctx._tagMemberNotesExpanded?.has(notesKey)) wrap.appendChild(buildMemberNotes(ctx, tag, m, mkey));
    if (ordered) { const b = mkInsert(i + 1); if (b) wrap.appendChild(b); }
  });
  return wrap;
}

function memberKindInfo(type) {
  if (type === 'span') return { icon: 'alphabet', label: '文本标注' };
  if (type === 'pos') return { icon: 'location', label: '位置标注' };
  return { icon: 'card', label: '节点标注' };
}

function showTagMemberPreview(ctx, tag, member, node, anchor) {
  clearTimeout(ctx._tagMemberPreviewTimer);
  closeTagMemberPreview(ctx, true);
  if (!node || !anchor?.isConnected) return;

  const type = memberType(member);
  const statement = ctx.getRendered ? ctx.getRendered(node.id, 'statement') : ctx.render(node.statementBody || '');
  const proof = node.proofBody ? (ctx.getRendered ? ctx.getRendered(node.id, 'proof') : ctx.render(node.proofBody)) : '';
  const sectionHTML = type === 'node'
    ? `<div class="statement">${statement}</div>${proof ? `<div class="proof-wrap">${proof}</div>` : ''}`
    : member.section === 'proof'
      ? `<div class="proof-wrap">${proof || statement}</div>`
      : `<div class="statement">${statement}</div>`;
  const preview = buildModalShell({
    type: node.type,
    color: typeColor(ctx.model, node.type),
    preview: true,
    titleHTML: `<span class="m-num">${escapeHtml(nodeTag(ctx.model, node))}</span> · ${escapeHtml(node.title || node.id)}`,
    bodyHTML: sectionHTML,
  });
  preview.classList.add('tag-member-preview', `tag-member-preview-${type}`);
  preview.dataset.id = node.id;
  preview.style.setProperty('--tc', tag.color || '#ff9e64');
  preview.addEventListener('mouseenter', () => clearTimeout(ctx._tagMemberPreviewTimer));
  preview.addEventListener('mouseleave', () => closeTagMemberPreview(ctx));
  document.body.appendChild(preview);
  ctx._tagMemberPreview = preview;
  positionTagMemberPreview(preview, anchor);

  const body = preview.querySelector('.modal-body');
  if (!body) return;
  body.style.maxHeight = type === 'node' ? '320px' : '230px';
  if (type === 'node') {
    requestAnimationFrame(() => positionTagMemberPreview(preview, anchor));
    return;
  }

  requestAnimationFrame(() => {
    if (!preview.isConnected) return;
    const range = type === 'span'
      ? ctx.modals?._rangeFromMember(body, member)
      : ctx.modals?._collapsedRangeFromMember(body, member);
    const targetRect = range?.getBoundingClientRect?.();
    const bodyRect = body.getBoundingClientRect();
    if (targetRect) body.scrollTop += targetRect.top - bodyRect.top - body.clientHeight / 2;
    else if (type === 'pos') body.scrollTop = Math.max(0, (member.y || 0) * body.scrollHeight - body.clientHeight / 2);
    requestAnimationFrame(() => {
      if (!preview.isConnected) return;
      renderTagMemberAnchor(ctx, body, tag, member, type);
      positionTagMemberPreview(preview, anchor);
    });
  });
}

function renderTagMemberAnchor(ctx, body, tag, member, type) {
  const bodyRect = body.getBoundingClientRect();
  let anchorRect = null;
  if (type === 'span') {
    const range = ctx.modals?._rangeFromMember(body, member);
    const rects = range ? groupAnnotationRects(annotationRectsFromRange(range, body)) : [];
    for (const rect of rects) {
      const underline = el('div', 'tag-preview-underline');
      underline.style.left = `${rect.left - bodyRect.left + body.scrollLeft}px`;
      underline.style.top = `${rect.bottom - bodyRect.top + body.scrollTop - 1}px`;
      underline.style.width = `${rect.width}px`;
      body.appendChild(underline);
    }
    anchorRect = rects.at(-1) || null;
  } else {
    const range = ctx.modals?._collapsedRangeFromMember(body, member);
    anchorRect = range?.getBoundingClientRect?.() || null;
  }

  const marker = el('div', `tag-preview-marker tag-preview-marker-${type}`);
  marker.innerHTML = type === 'span' ? (ICON[tag.icon] || ICON.tag) : ICON.location;
  if (anchorRect) {
    marker.style.left = `${anchorRect.right - bodyRect.left + body.scrollLeft + 4}px`;
    marker.style.top = `${anchorRect.top - bodyRect.top + body.scrollTop + anchorRect.height / 2}px`;
  } else {
    marker.style.left = `${Math.max(8, Math.min(body.clientWidth - 8, (member.x || 0) * body.clientWidth))}px`;
    marker.style.top = `${Math.max(8, (member.y || 0) * body.scrollHeight)}px`;
  }
  body.appendChild(marker);
}

function positionTagMemberPreview(preview, anchor) {
  if (!preview?.isConnected || !anchor?.isConnected) return;
  const gap = 10;
  const ar = anchor.getBoundingClientRect();
  const width = preview.offsetWidth;
  const height = preview.offsetHeight;
  let left = ar.right + gap;
  if (left + width > window.innerWidth - 8) left = Math.max(8, ar.left - width - gap);
  let top = ar.top - 10;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
}

function closeTagMemberPreview(ctx, immediate = false) {
  clearTimeout(ctx._tagMemberPreviewTimer);
  const close = () => {
    ctx._tagMemberPreview?.remove();
    ctx._tagMemberPreview = null;
    ctx._tagMemberPreviewTimer = null;
  };
  if (immediate) close();
  else ctx._tagMemberPreviewTimer = setTimeout(close, 120);
}

export function buildMemberNotes(ctx, tag, member, mkey) {
  const section = el('div', 'tag-notes');
  const notes = ctx.notesForMember?.(tag, member) || [];
  const head = el('div', 'tag-notes-head');
  const label = el('span', 'tag-notes-instance-label'); label.textContent = `此标注的笔记 · ${notes.length}`;
  const add = mkIc('plus', '添加笔记', (event) => ctx.openNoteEditor?.('', { tagPointer: notePointerFromMember(tag, member), anchor: event.currentTarget }));
  head.append(label, add);
  section.appendChild(head);
  const list = el('div', 'tag-note-list');
  if (!notes.length) {
    const empty = el('div', 'tag-note-empty'); empty.textContent = '暂无笔记'; list.appendChild(empty);
  }
  for (const note of notes) list.appendChild(createNoteRow(ctx, note, { className: 'sidebar-note-row' }));
  section.appendChild(list);
  return section;
}

export function openTagNoteEditor(ctx, tagId, { memberKey: targetMemberKey = '', noteId = '', anchor = null } = {}) {
  const tag = (ctx.graph.getTags() || []).find((item) => item.id === tagId);
  const member = tag?.members?.find((item) => memberKey(item) === targetMemberKey);
  return openNoteEditor(ctx, noteId, { tagPointer: notePointerFromMember(tag, member), anchor });
}

export function openNoteEditor(ctx, noteId = '', { tagPointer = undefined, anchor = null } = {}) {
  ctx._tagNoteEditorClose?.();
  ctx.noteWindows?.close?.();
  const tags = ctx.graph.getTags() || [];
  const existing = (ctx.getNotes?.() || []).find((item) => item.id === noteId) || null;
  const now = new Date().toISOString();
  const state = {
    noteId: existing?.id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: existing?.createdAt || now,
    tagPointer: existing ? existing.tagPointer : (tagPointer ?? null),
    persisted: !!existing,
    saveTimer: null,
    initial: existing ? structuredClone(existing) : null,
  };

  const editor = el('section', 'tag-note-editor');
  const head = el('header', 'tag-note-editor-head');
  const identity = el('button', 'tag-note-identity'); identity.type = 'button'; identity.title = '更改依附标签';
  const status = el('span', 'tag-note-save-status'); status.textContent = existing ? '已保存' : '未创建';
  const actions = el('div', 'tag-note-editor-actions');
  const action = (icon, label, handler) => {
    const button = el('button', `tag-note-editor-action tag-note-editor-action-${icon}`); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = `<span class="tag-note-editor-action-glyph">${ICON[icon] || ''}</span>`;
    button.addEventListener('click', handler); actions.appendChild(button); return button;
  };
  const rollback = action('undo', '回到打开时的状态', () => restoreOpeningState());
  const copyReference = action('link', '复制笔记引用', () => copyNoteReference());
  const attachAi = action('aiAdd', '引用到 AI', () => attachNoteToAi());
  const copyAll = action('copy', '复制所有内容', () => copyAllContent());
  const previewToggle = action('eye', '预览', () => setMode(editor.dataset.mode === 'preview' ? 'edit' : 'preview'));
  const close = action('close', '关闭', () => closeEditor());
  head.append(identity, status, actions);

  const picker = el('div', 'tag-note-tag-picker'); picker.hidden = true;
  const body = el('div', 'tag-note-editor-body');
  const editSurface = el('div', 'tag-note-edit-surface');
  const title = el('input', 'tag-note-title-input'); title.type = 'text'; title.value = existing?.title || '';
  const textarea = el('textarea', 'tag-note-textarea'); textarea.placeholder = '记录想法，支持 Markdown、公式和图谱引用…'; textarea.value = existing?.content || '';
  editSurface.append(title, textarea);
  const preview = el('div', 'tag-note-preview'); preview.hidden = true;
  body.append(editSurface, preview);
  editor.append(head, picker, body);
  document.body.appendChild(editor);
  ctx._tagNoteEditor = editor;
  editor.dataset.mode = 'edit';
  ctx.noteWindows?.applySize?.(editor);
  if (anchor) ctx.noteWindows?.position?.(editor, anchor);
  else ctx.noteWindows?.clampPosition?.(editor, ctx.noteWindows?.lastPosition || { left: 292, top: 40 });
  const disconnectSize = ctx.noteWindows?.observeSize?.(editor) || (() => {});
  const disconnectEdges = ctx.noteWindows?.attachEdgeResize?.(editor) || (() => {});
  const onViewportResize = () => ctx.noteWindows?.clampPosition?.(editor);
  window.addEventListener('resize', onViewportResize);

  const current = () => resolveNotePointer({ tagPointer: state.tagPointer }, ctx.graph.getTags() || []) || { tag: null, member: null };
  const noteFromInputs = () => ({
    id: state.noteId,
    title: title.value.trim(),
    content: textarea.value,
    tagPointer: state.tagPointer,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
  });
  const hasDraft = () => state.persisted || title.value.trim() || textarea.value;
  const updateIdentity = () => {
    const { tag } = current();
    identity.innerHTML = `<span class="tag-note-identity-icon">${ICON.note}</span><span class="tag-note-identity-label">${escapeHtml(tag?.label || tag?.id || '无标签')}</span><span class="tag-note-identity-caret">${ICON.chevronDown}</span>`;
  };
  const persistNow = ({ force = false } = {}) => {
    clearTimeout(state.saveTimer); state.saveTimer = null;
    if (!force && !hasDraft()) { status.textContent = '未创建'; return null; }
    const note = noteFromInputs();
    ctx.persistNotes(upsertNote(ctx.getNotes?.() || [], note, ctx.graph.getTags() || []));
    state.persisted = true;
    status.textContent = '已保存';
    return note;
  };
  const scheduleSave = () => {
    clearTimeout(state.saveTimer);
    status.textContent = '保存中…';
    state.saveTimer = setTimeout(() => persistNow(), 380);
  };
  const growTextarea = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, editSurface.clientHeight - title.offsetHeight)}px`;
  };
  const renderPreview = () => {
    preview.replaceChildren();
    if (title.value.trim()) {
      const previewTitle = el('div', 'tag-note-preview-title'); previewTitle.textContent = title.value.trim(); preview.appendChild(previewTitle);
    }
    const previewBody = el('div', 'tag-note-preview-content ai-markdown'); preview.appendChild(previewBody);
    renderMarkdownInto(previewBody, textarea.value || '*空笔记*', {
      macros: ctx.model?.meta?.macros,
      graphLabels: ctx.model?.labelIndex,
      onGraphReference: (reference) => {
        const noteRef = resolveTagNoteReference(reference, ctx.graph?.getTags?.() || [], ctx.getNotes?.() || []);
        if (noteRef) {
          ctx.openNoteEditor?.(noteRef.note.id, { anchor: editor });
          return;
        }
        const referencedMember = graphReferenceToMember(reference, ctx.graph?.getTags?.() || [], ctx.getNotes?.() || []);
        if (referencedMember) ctx.jumpToMember?.(referencedMember);
      },
    });
  };
  const setMode = (mode) => {
    const showingPreview = mode === 'preview';
    editor.dataset.mode = showingPreview ? 'preview' : 'edit';
    editSurface.hidden = showingPreview; editSurface.style.display = showingPreview ? 'none' : '';
    preview.hidden = !showingPreview; preview.style.display = showingPreview ? 'block' : 'none';
    previewToggle.classList.toggle('on', showingPreview);
    previewToggle.title = showingPreview ? '返回编辑' : '预览';
    if (showingPreview) { persistNow(); renderPreview(); } else textarea.focus();
  };
  const renderPicker = () => {
    picker.replaceChildren();
    const none = el('button', `tag-note-tag-option${state.tagPointer ? '' : ' current'}`); none.type = 'button';
    none.innerHTML = `<span>${ICON.note}</span><span>无标签</span>${state.tagPointer ? '' : ICON.check}`;
    none.addEventListener('click', () => setPointer(null)); picker.appendChild(none);
    for (const tag of ctx.graph.getTags() || []) {
      const group = el('div', 'tag-note-picker-group');
      group.innerHTML = `<span>${ICON[tag.icon] || ICON.tag}</span><strong>${escapeHtml(tag.label || tag.id)}</strong>`;
      picker.appendChild(group);
      for (const member of tag.members || []) {
        const pointer = notePointerFromMember(tag, member);
        const selected = samePointer(pointer, state.tagPointer);
        const node = ctx.model.nodeById.get(memberNode(member));
        const kind = memberKindInfo(memberType(member));
        const button = el('button', `tag-note-tag-option tag-note-instance-option${selected ? ' current' : ''}`); button.type = 'button';
        button.innerHTML = `<span>${ICON[kind.icon]}</span><span>${escapeHtml(node?.title || memberNode(member) || '未知节点')}<small>${escapeHtml(kind.label)}</small></span>${selected ? ICON.check : ''}`;
        button.addEventListener('click', () => setPointer(pointer)); picker.appendChild(button);
      }
    }
  };
  const setPointer = (pointer) => {
    state.tagPointer = pointer;
    picker.hidden = true; updateIdentity(); persistNow({ force: true });
  };
  const copyAllContent = async () => {
    persistNow();
    const copied = await writePlainText([title.value.trim(), textarea.value].filter(Boolean).join('\n\n'));
    toast(copied ? '已复制笔记内容' : '复制失败', copied ? {} : { type: 'error' });
  };
  const copyNoteReference = async () => {
    const note = persistNow({ force: true });
    const copied = await writeGraphReference(noteReferenceFromNote(ctx.model, note, ctx.graph.getTags() || []));
    toast(copied ? '已复制笔记引用' : '复制失败', copied ? {} : { type: 'error' });
  };
  const attachNoteToAi = () => {
    const note = persistNow({ force: true });
    const attached = ctx.aiPanel?.attachNote?.(note);
    toast(attached ? '笔记已附到 AI' : '无法附到 AI', attached ? {} : { type: 'error' });
  };
  const restoreOpeningState = () => {
    clearTimeout(state.saveTimer); state.saveTimer = null;
    if (state.persisted) {
      const next = state.initial
        ? upsertNote(ctx.getNotes?.() || [], { ...state.initial }, ctx.graph.getTags() || [])
        : removeNote(ctx.getNotes?.() || [], state.noteId);
      ctx.persistNotes(next);
    }
    state.tagPointer = state.initial?.tagPointer || null;
    state.createdAt = state.initial?.createdAt || now; state.persisted = !!state.initial;
    title.value = state.initial?.title || ''; textarea.value = state.initial?.content || '';
    setMode('edit'); updateIdentity(); status.textContent = state.persisted ? '已恢复并保存' : '已恢复';
    toast('已回到打开时的状态');
  };
  let closing = false;
  const closeEditor = () => {
    if (closing) return; closing = true;
    persistNow();
    disconnectSize();
    disconnectEdges();
    window.removeEventListener('resize', onViewportResize);
    ctx.noteWindows?.saveSize?.(editor);
    editor.remove();
    if (ctx._tagNoteEditor === editor) ctx._tagNoteEditor = null;
    if (ctx._tagNoteEditorClose === closeEditor) ctx._tagNoteEditorClose = null;
  };
  ctx._tagNoteEditorClose = closeEditor;

  let drag = null;
  head.addEventListener('pointerdown', (event) => {
    if (window.matchMedia?.('(max-width: 760px)').matches || event.button !== 0 || event.target.closest('button')) return;
    const rect = editor.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    head.setPointerCapture?.(event.pointerId); event.preventDefault();
  });
  head.addEventListener('pointermove', (event) => {
    if (!drag) return;
    ctx.noteWindows?.clampPosition?.(editor, { left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y });
  });
  const endDrag = () => { drag = null; };
  head.addEventListener('pointerup', endDrag); head.addEventListener('pointercancel', endDrag);

  identity.addEventListener('click', () => { renderPicker(); picker.hidden = !picker.hidden; });
  title.addEventListener('input', scheduleSave);
  textarea.addEventListener('input', () => { growTextarea(); scheduleSave(); });
  bindGraphReferencePaste(textarea);
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!picker.hidden) picker.hidden = true; else closeEditor();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); persistNow({ force: true }); }
  });
  updateIdentity();
  requestAnimationFrame(growTextarea);
  requestAnimationFrame(() => (existing ? textarea : title).focus());
  return editor;
}

function samePointer(a, b) {
  if (!a || !b) return !a && !b;
  return a.tagId === b.tagId && ((a.referenceId && b.referenceId && a.referenceId === b.referenceId) || a.instanceId === b.instanceId);
}

function createTag(ctx, kind) {
  const tags = ctx.graph.getTags() || [];
  const existing = new Set(tags.map((t) => t.id));
  let id = kind === 'ordered' ? 'mainpath' : 'tag';
  if (existing.has(id)) { let k = 2; while (existing.has(`${id}-${k}`)) k += 1; id = `${id}-${k}`; }
  // 取标签调色板里首个未被占用的颜色（删除后不撞色）；全用尽再按数量回绕
  const used = new Set(tags.map((t) => t.color));
  const color = TAG_COLORS.find((c) => !used.has(c)) || TAG_COLORS[tags.length % TAG_COLORS.length];
  const tag = { id, label: '新标签', kind, icon: kind === 'ordered' ? 'route' : 'tag', color, visible: true, members: [] };
  ctx.persistTags([...tags, tag]);
  ctx.setTagEditing(id);
}

function mkIc(icon, title, onClick) {
  const b = el('button', 'tag-ic'); b.type = 'button'; b.title = title;
  b.innerHTML = ICON[icon] || ICON.tag;
  b.addEventListener('click', onClick);
  return b;
}

// ---- 控件工厂 ----
function toggleRow(labelHtml, on, onClick, dotColor = null) {
  const row = el('button', 'toggle-row');
  row.type = 'button';
  const dot = dotColor ? `<span class="tr-dot" style="background:${dotColor}"></span>` : '';
  row.innerHTML = `${dot}<span class="tr-label">${labelHtml}</span><span class="tr-check">${ICON.check}</span>`;
  const set = (v) => { row.classList.toggle('on', v); row.classList.toggle('off', !v); };
  set(on);
  row.addEventListener('click', onClick);
  return { row, set };
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

// 普通分组（不可折叠）
function group(root, label) {
  const g = el('div', 'side-group');
  const l = el('div', 'side-label'); l.textContent = label;
  g.appendChild(l);
  root.appendChild(g);
  return g;
}

// 可折叠分区，状态持久化；返回 body 容器
function section(root, label, key, defaultCollapsed) {
  const g = el('div', 'side-group disclosure');
  const stored = localStorage.getItem(`hg-sec-${key}`);
  const collapsed = stored != null ? stored === '1' : !!defaultCollapsed;
  g.classList.toggle('collapsed', collapsed);
  const head = el('button', 'disc-head');
  head.type = 'button';
  head.innerHTML = `<span class="disc-caret">${ICON.chevronDown}</span><span>${escapeHtml(label)}</span>`;
  head.addEventListener('click', () => {
    const now = g.classList.toggle('collapsed');
    localStorage.setItem(`hg-sec-${key}`, now ? '1' : '0');
  });
  const body = el('div', 'disc-body');
  g.appendChild(head);
  g.appendChild(body);
  root.appendChild(g);
  return body;
}

function subLabel(text) { const d = el('div', 'side-sublabel'); d.textContent = text; return d; }
function btn(text, onClick, icon) { const b = el('button', 'btn btn--sm btn--block'); b.type = 'button'; b.innerHTML = `${icon && ICON[icon] ? ICON[icon] : ''}<span>${escapeHtml(text)}</span>`; b.addEventListener('click', onClick); return b; }
function iconBtn(title, icon, onClick) { const b = el('button', 'icon-btn'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = ICON[icon] || ''; if (onClick) b.addEventListener('click', onClick); return b; }
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function projectLocationLabel(project, user) {
  if (project?.sync?.state === 'synced') return '云端';
  if (user && project?.sync?.location === 'cloud') return '待同步';
  return '本地';
}
