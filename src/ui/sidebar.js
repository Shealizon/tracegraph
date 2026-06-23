// =============================================================================
// ui/sidebar.js  —  侧栏（统一控件 · 可折叠分区）
// =============================================================================
import { ICON } from './icons.js';
import { nodeTag, typeColor, TAG_COLORS, isLeafNode, memberNode, memberType, memberKey } from '../data/schema.js';
import { confirmDialog } from './feedback.js';

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
  const app = document.getElementById('app');
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

  // ---- 头部：返回首页 · 项目名 · 溢出菜单 ----
  const head = el('div', 'side-head');
  const homeBtn = iconBtn('返回项目首页', 'home', () => ctx.goLeading && ctx.goLeading());
  const titleWrap = el('div', 'side-head-text');
  titleWrap.innerHTML = `<div class="side-title">${escapeHtml(model.meta.title || '关系图')}</div><div class="side-sub">${model.meta.counts.statements} 节点 · ${model.meta.counts.edges} 关系${model.hasCycle ? ' · 含环' : ''}</div>`;
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
  ctx.rebuildTagPanel = () => renderTagPanel(ctx, tagBody);
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
  const cardable = tag.members.map((id) => ctx.model.nodeById.get(id)).filter((n) => n && !n._userHidden && !isLeafNode(ctx.model, n));
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
    const sub = mt === 'span' ? `<span class="tm-sub">「${escapeHtml((m.text || '').slice(0, 16))}」</span>` : mt === 'pos' ? '<span class="tm-sub">📍位置</span>' : '';
    mrow.innerHTML = `${lead}<span class="tm-label">${escapeHtml(n ? (n.title || n.id) : mid)}</span>${sub}`;
    mrow.title = '聚焦';
    const del = el('button', 'tm-del'); del.type = 'button'; del.textContent = '×'; del.title = '移出';
    del.addEventListener('click', (e) => { e.stopPropagation(); ctx.persistTags(ctx.graph.getTags().map((t) => (t.id === tag.id ? { ...t, members: t.members.filter((x) => memberKey(x) !== mkey) } : t))); });
    mrow.appendChild(del);
    // 点击成员：聚焦该节点（span/pos 后续可滚动定位）
    mrow.addEventListener('click', () => {
      if (!n) return;
      if (n._userHidden) ctx.unhideNode(mid);
      ctx.graph.focusNode(mid, ctx.graph.getZoomScale());
      const e2 = ctx.graph.nodeEls.get(mid);
      if (e2) { e2.classList.add('search-hit'); setTimeout(() => e2.classList.remove('search-hit'), 1500); }
    });
    wrap.appendChild(mrow);
    if (ordered) { const b = mkInsert(i + 1); if (b) wrap.appendChild(b); }
  });
  return wrap;
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
