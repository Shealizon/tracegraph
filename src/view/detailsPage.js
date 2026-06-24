// =============================================================================
// view/detailsPage.js  —  Reader / details view
//   Mobile-first paper reading surface with persistent tabs, page history,
//   scroll memory, and a graph-free node library page.
// =============================================================================

import { isLeafNode, nodeTag, paperName, typeColor } from '../data/schema.js';
import { ICON } from '../ui/icons.js';
import { toast } from '../ui/feedback.js';
import { selectionSource } from '../ui/cardMenus.js';

const STORE_PREFIX = 'paper-graph:reader:';
let seq = 1;

export function openDetails(ctx, nodeId, opts = {}) {
  const reader = ensureReader(ctx);
  if (opts.newTab || !reader.tabs.length) addNodeTab(reader, nodeId);
  else navigate(reader, reader.activeId, nodePage(nodeId));
  renderReader(reader);
}

export function openReaderLibrary(ctx) {
  const reader = ensureReader(ctx);
  if (!reader.tabs.length) addLibraryTab(reader);
  renderReader(reader);
}

export function openReaderRoute(ctx, route = {}) {
  const reader = ensureReader(ctx);
  const page = parseRoutePage(route.page);
  if (page) activatePage(reader, page);
  else if (!reader.tabs.length) addLibraryTab(reader);
  renderReader(reader);
}

export function getReaderRoute(ctx) {
  const reader = ctx._reader;
  if (!reader || !document.body.contains(reader.el)) return null;
  const tab = activeTab(reader);
  if (!tab) return { page: 'library' };
  return { page: tab.kind === 'node' ? `node:${tab.nodeId}` : 'library' };
}

function ensureReader(ctx) {
  if (ctx._reader && document.body.contains(ctx._reader.el)) return ctx._reader;

  const el = document.createElement('div');
  el.className = 'details-page reader-page';
  document.body.appendChild(el);
  const reader = {
    ctx,
    el,
    tabs: [],
    activeId: '',
    previewEl: null,
    storageKey: storageKey(ctx),
  };
  ctx._reader = reader;
  restoreState(reader);
  bindReaderSelectionSurface(reader);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (reader.previewEl) closePreview(reader);
      else closeReader(reader);
    }
  });
  const onKey = (e) => {
    if (!document.body.contains(el)) {
      window.removeEventListener('keydown', onKey);
      return;
    }
    if (e.key === 'Escape') {
      if (reader.previewEl) closePreview(reader);
      else closeReader(reader);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      addLibraryTab(reader);
      renderReader(reader);
    }
  };
  window.addEventListener('keydown', onKey);
  return reader;
}

function closeReader(reader) {
  saveScroll(reader);
  persistState(reader);
  closeReaderCopyMenu(reader);
  closeReaderSelectionMenu(reader);
  clearTimeout(reader.selectionTimer);
  if (reader.selectionChangeHandler) {
    document.removeEventListener('selectionchange', reader.selectionChangeHandler);
    reader.selectionChangeHandler = null;
  }
  reader.el.remove();
  reader.ctx._reader = null;
  reader.ctx.writeHash && reader.ctx.writeHash();
}

function storageKey(ctx) {
  const id = ctx.model?.meta?.projectId || ctx.model?.meta?.sourcePath || ctx.model?.meta?.title || location.pathname;
  return `${STORE_PREFIX}${String(id).slice(0, 180)}`;
}

function pageKey(page) {
  return page?.kind === 'node' ? page.nodeId : 'library';
}

function nodePage(nodeId) {
  return { kind: 'node', nodeId };
}

function libraryPage(query = '') {
  return { kind: 'library', query };
}

function pageFromTab(tab) {
  return tab.kind === 'node' ? nodePage(tab.nodeId) : libraryPage(tab.query || '');
}

function setTabPage(tab, page) {
  tab.kind = page.kind === 'node' ? 'node' : 'library';
  tab.nodeId = tab.kind === 'node' ? page.nodeId : '';
  tab.query = tab.kind === 'library' ? (page.query || tab.query || '') : (tab.query || '');
}

function addLibraryTab(reader) {
  const tab = createTab(libraryPage());
  reader.tabs.push(tab);
  reader.activeId = tab.id;
  persistState(reader);
  return tab;
}

function addNodeTab(reader, nodeId) {
  if (!nodeId) return null;
  const tab = createTab(nodePage(nodeId));
  reader.tabs.push(tab);
  reader.activeId = tab.id;
  persistState(reader);
  return tab;
}

function activatePage(reader, page) {
  const key = pageKey(page);
  let tab = reader.tabs.find((t) => pageKey(pageFromTab(t)) === key);
  if (!tab) {
    tab = page.kind === 'node' ? addNodeTab(reader, page.nodeId) : addLibraryTab(reader);
  } else {
    if (page.kind === 'library') tab.query = page.query || tab.query || '';
    reader.activeId = tab.id;
    persistState(reader);
  }
  return tab;
}

function createTab(page) {
  const tab = {
    id: `tab-${seq++}`,
    kind: 'library',
    nodeId: '',
    query: '',
    back: [],
    forward: [],
    scroll: {},
  };
  setTabPage(tab, page);
  return tab;
}

function activeTab(reader) {
  return reader.tabs.find((t) => t.id === reader.activeId) || reader.tabs[0] || null;
}

function navigate(reader, tabId, page, push = true) {
  const tab = reader.tabs.find((t) => t.id === tabId);
  if (!tab || !page || (page.kind === 'node' && !page.nodeId)) return;
  if (pageKey(pageFromTab(tab)) === pageKey(page)) return;
  saveScroll(reader);
  if (push) tab.back.push(pageFromTab(tab));
  setTabPage(tab, page);
  if (push) tab.forward = [];
  persistState(reader);
}

function goHistory(reader, dir) {
  const tab = activeTab(reader);
  if (!tab) return;
  const from = dir < 0 ? tab.back : tab.forward;
  const to = dir < 0 ? tab.forward : tab.back;
  const next = from.pop();
  if (!next) return;
  saveScroll(reader);
  to.push(pageFromTab(tab));
  setTabPage(tab, next);
  persistState(reader);
  renderReader(reader);
}

function closeTab(reader, tabId) {
  saveScroll(reader);
  const i = reader.tabs.findIndex((t) => t.id === tabId);
  if (i < 0) return;
  reader.tabs.splice(i, 1);
  if (!reader.tabs.length) {
    localStorage.removeItem(reader.storageKey);
    closeReader(reader);
    return;
  }
  if (reader.activeId === tabId) reader.activeId = reader.tabs[Math.max(0, i - 1)].id;
  persistState(reader);
  renderReader(reader);
}

function renderReader(reader) {
  const { el } = reader;
  const tab = activeTab(reader);
  if (!tab && !reader.tabs.length) addLibraryTab(reader);

  el.innerHTML = `
    <div class="reader-shell">
      ${renderTabs(reader)}
      ${renderToolbar(reader)}
      <div class="reader-body">
        ${renderActivePage(reader)}
      </div>
    </div>`;

  bindReader(reader);
  requestAnimationFrame(() => restoreScroll(reader));
  el.focus();
  reader.ctx.writeHash && reader.ctx.writeHash();
}

function renderActivePage(reader) {
  const tab = activeTab(reader);
  if (!tab || tab.kind === 'library') return renderLibraryPage(reader, tab);
  const node = reader.ctx.model.nodeById.get(tab.nodeId);
  return node ? renderNode(reader, node) : renderLibraryPage(reader, tab);
}

function renderTabs(reader) {
  const { ctx } = reader;
  return `<div class="reader-tabs" role="tablist">
    ${reader.tabs.map((t) => {
      const n = t.kind === 'node' ? ctx.model.nodeById.get(t.nodeId) : null;
      const active = t.id === reader.activeId;
      const title = n?.title || n?.id || '阅读列表';
      return `<button class="reader-tab${active ? ' active' : ''}" data-tab="${escapeAttr(t.id)}" role="tab" title="${escapeAttr(title)}">
        <span class="rt-num" style="color:${n ? typeColor(ctx.model, n.type) : ''}">${n ? escapeHtml(nodeTag(ctx.model, n)) : ICON.listOrdered}</span>
        <span class="rt-title">${escapeHtml(title)}</span>
        <span class="rt-close" data-close-tab="${escapeAttr(t.id)}">${ICON.close}</span>
      </button>`;
    }).join('')}
    <button class="reader-tab reader-tab-add" data-new-tab title="新标签">${ICON.plus}</button>
  </div>`;
}

function renderToolbar(reader) {
  const tab = activeTab(reader);
  const canBack = !!tab?.back.length;
  const canForward = !!tab?.forward.length;
  return `<div class="reader-toolbar">
    <button class="reader-tool" data-back ${canBack ? '' : 'disabled'} title="返回">${ICON.chevronDown}</button>
    <button class="reader-tool reader-forward" data-forward ${canForward ? '' : 'disabled'} title="前进">${ICON.chevronDown}</button>
    <button class="reader-tool reader-primary" data-library title="阅读列表">${ICON.search}<span>阅读列表</span></button>
    <span class="reader-spacer"></span>
    <button class="reader-tool" data-copy-current ${tab?.kind === 'node' ? '' : 'disabled'} title="复制">${ICON.copy}</button>
    <button class="reader-tool" data-new-current title="新标签">${ICON.plus}</button>
    <button class="reader-tool" data-close-reader title="关闭">${ICON.close}</button>
  </div>`;
}

function renderNode(reader, node) {
  const { ctx } = reader;
  const model = ctx.model;
  const deps = [...(model.deps.get(node.id) || [])];
  const usedBy = [...(model.usedBy.get(node.id) || [])];
  const paper = paperName(model, node);
  const idx = model.nodes.findIndex((n) => n.id === node.id);
  const proofLabel = model.meta.proofLabel || '详情';

  if (isLeafNode(model, node)) {
    return `<article class="reader-layout" data-node-id="${escapeAttr(node.id)}" style="--reader-color:${typeColor(model, node.type)}">
      <main class="reader-main" tabindex="0">
        ${nodeHero(reader, node, { deps, usedBy, paper, idx })}
        <section class="reader-content reader-source">
          <p>来源条目 <code>${escapeHtml(node.id)}</code></p>
          ${node.statementBody ? ctx.render(node.statementBody) : `<p>${escapeHtml(node.title || '')}</p>`}
        </section>
      </main>
    </article>`;
  }

  const statement = ctx.getRendered ? ctx.getRendered(node.id, 'statement') : ctx.render(node.statementBody);
  const proof = node.proofBody ? (ctx.getRendered ? ctx.getRendered(node.id, 'proof') : ctx.render(node.proofBody)) : '';
  return `<article class="reader-layout" data-node-id="${escapeAttr(node.id)}" style="--reader-color:${typeColor(model, node.type)}">
    <main class="reader-main" tabindex="0">
      ${nodeHero(reader, node, { deps, usedBy, paper, idx })}
      <section class="reader-content">
        <div class="statement">${statement || '<p class="reader-muted">无正文。</p>'}</div>
        ${proof ? `<details class="reader-proof" open><summary>${escapeHtml(proofLabel)}</summary><div class="proof-wrap">${proof}</div></details>` : ''}
      </section>
    </main>
  </article>`;
}

function nodeHero(reader, node, { deps, usedBy, paper, idx }) {
  const { ctx } = reader;
  return `<header class="reader-hero" style="--reader-color:${typeColor(ctx.model, node.type)}">
    <div class="reader-hero-top">
      <span class="reader-node-tag">${escapeHtml(nodeTag(ctx.model, node))}</span>
      ${paper ? `<span class="reader-paper">${ICON.fileText}${escapeHtml(paper)}</span>` : ''}
    </div>
    <h1>${escapeHtml(node.title || node.id)}</h1>
    <div class="reader-position">
      <span>全局 ${idx + 1}/${ctx.model.nodes.length}</span>
      <span>依赖 ${deps.length}</span>
      <span>被使用 ${usedBy.length}</span>
      <span>重要度 ${node.importance ?? 1}</span>
      ${node.inCycle ? '<span>环中节点</span>' : ''}
    </div>
    <div class="reader-map">
      ${miniGroup('依赖', deps, reader)}
      ${miniGroup('被使用', usedBy, reader)}
    </div>
  </header>`;
}

function miniGroup(label, ids, reader) {
  const visible = ids.slice(0, 5);
  if (!ids.length) return `<div class="reader-mini"><b>${label}</b><span class="reader-muted">无</span></div>`;
  return `<div class="reader-mini"><b>${label}</b><div>${visible.map((id) => miniChip(reader, id)).join('')}${ids.length > visible.length ? `<span class="reader-more">+${ids.length - visible.length}</span>` : ''}</div></div>`;
}

function miniChip(reader, id) {
  const n = reader.ctx.model.nodeById.get(id);
  if (!n) return '';
  return `<button class="reader-chip" data-goto="${escapeAttr(id)}" data-long-preview="${escapeAttr(id)}" style="--chip-color:${typeColor(reader.ctx.model, n.type)}">${escapeHtml(nodeTag(reader.ctx.model, n))}</button>`;
}

function renderLibraryPage(reader, tab) {
  const nodes = filteredNodes(reader, tab);
  return `<section class="reader-library-page" tabindex="0">
    <div class="reader-library-head">
      <strong>阅读列表</strong>
      <span>${nodes.length}/${reader.ctx.model.nodes.length}</span>
    </div>
    <div class="reader-library-search">
      <span>${ICON.search}</span>
      <input data-library-query placeholder="搜索编号、标题、类型" value="${escapeAttr(tab?.query || '')}">
    </div>
    <div class="reader-library-list">
      ${nodes.map((n) => `<button class="reader-library-item" data-library-open="${escapeAttr(n.id)}" data-long-preview="${escapeAttr(n.id)}">
        <span style="color:${typeColor(reader.ctx.model, n.type)}">${escapeHtml(nodeTag(reader.ctx.model, n))}</span>
        <b>${escapeHtml(n.title || n.id)}</b>
        <small>${escapeHtml(paperName(reader.ctx.model, n) || n.typeLabel || n.type || '')}</small>
      </button>`).join('') || '<div class="reader-muted">没有匹配条目。</div>'}
    </div>
  </section>`;
}

function bindReader(reader) {
  const { el } = reader;
  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-tab]')) return;
    saveScroll(reader);
    reader.activeId = b.dataset.tab;
    persistState(reader);
    renderReader(reader);
  }));
  el.querySelectorAll('[data-close-tab]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(reader, b.dataset.closeTab);
  }));
  el.querySelector('[data-back]')?.addEventListener('click', () => goHistory(reader, -1));
  el.querySelector('[data-forward]')?.addEventListener('click', () => goHistory(reader, 1));
  el.querySelector('[data-copy-current]')?.addEventListener('click', (e) => openReaderCopyMenu(reader, e.currentTarget));
  el.querySelector('[data-library]')?.addEventListener('click', () => {
    navigate(reader, reader.activeId, libraryPage(activeTab(reader)?.query || ''));
    renderReader(reader);
  });
  el.querySelector('[data-new-tab]')?.addEventListener('click', () => {
    saveScroll(reader);
    addLibraryTab(reader);
    renderReader(reader);
  });
  el.querySelector('[data-new-current]')?.addEventListener('click', () => {
    saveScroll(reader);
    addLibraryTab(reader);
    renderReader(reader);
  });
  el.querySelector('[data-close-reader]')?.addEventListener('click', () => closeReader(reader));

  el.querySelectorAll('[data-goto]').forEach((target) => {
    target.addEventListener('click', (e) => {
      if (consumeLongPress(target)) { e.preventDefault(); return; }
      navigate(reader, reader.activeId, nodePage(target.dataset.goto));
      renderReader(reader);
    });
    bindLongPress(target, () => showPreview(reader, target.dataset.longPreview || target.dataset.goto, target));
  });

  bindInlineRefs(reader);
  bindLibrary(reader);
  bindScrollMemory(reader);
}

function bindInlineRefs(reader) {
  const { ctx, el } = reader;
  el.querySelectorAll('.reader-content .texref').forEach((ref) => {
    const target = ref.dataset.target;
    const owner = ref.dataset.owner || ctx.ownerOf(target);
    if (!owner) return;
    ref.title = '打开引用；长按预览';
    ref.addEventListener('click', (e) => {
      if (consumeLongPress(ref)) { e.preventDefault(); return; }
      e.preventDefault();
      e.stopPropagation();
      navigate(reader, reader.activeId, nodePage(owner));
      renderReader(reader);
    });
    bindLongPress(ref, () => showPreview(reader, owner, ref));
  });
}

function bindLibrary(reader) {
  const tab = activeTab(reader);
  const input = reader.el.querySelector('[data-library-query]');
  if (input) {
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('input', () => {
      if (!tab) return;
      tab.query = input.value;
      saveScroll(reader);
      persistState(reader);
      const list = reader.el.querySelector('.reader-library-list');
      if (!list) return;
      list.innerHTML = filteredNodes(reader, tab).map((n) => `<button class="reader-library-item" data-library-open="${escapeAttr(n.id)}" data-long-preview="${escapeAttr(n.id)}">
        <span style="color:${typeColor(reader.ctx.model, n.type)}">${escapeHtml(nodeTag(reader.ctx.model, n))}</span>
        <b>${escapeHtml(n.title || n.id)}</b>
        <small>${escapeHtml(paperName(reader.ctx.model, n) || n.typeLabel || n.type || '')}</small>
      </button>`).join('') || '<div class="reader-muted">没有匹配条目。</div>';
      bindLibraryItems(reader, list);
    });
  }
  bindLibraryItems(reader, reader.el);
}

function bindLibraryItems(reader, root) {
  root.querySelectorAll('[data-library-open]').forEach((b) => {
    b.addEventListener('click', () => {
      if (consumeLongPress(b)) return;
      const tab = activeTab(reader) || addLibraryTab(reader);
      navigate(reader, tab.id, nodePage(b.dataset.libraryOpen), tab.kind === 'node' || tab.kind === 'library');
      reader.activeId = tab.id;
      persistState(reader);
      renderReader(reader);
    });
    bindLongPress(b, () => showPreview(reader, b.dataset.libraryOpen, b));
  });
}

function bindLongPress(el, fn) {
  let timer = null;
  const clear = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    timer = setTimeout(() => {
      timer = null;
      el.dataset.longPressed = '1';
      fn();
      setTimeout(() => { delete el.dataset.longPressed; }, 650);
    }, 520);
  });
  el.addEventListener('pointerup', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener('pointerleave', clear);
}

function consumeLongPress(el) {
  if (el?.dataset?.longPressed !== '1') return false;
  delete el.dataset.longPressed;
  return true;
}

function showPreview(reader, nodeId, anchorEl) {
  const node = reader.ctx.model.nodeById.get(nodeId);
  if (!node) return;
  closePreview(reader);
  const statement = isLeafNode(reader.ctx.model, node)
    ? (node.statementBody ? reader.ctx.render(node.statementBody) : `<p>${escapeHtml(node.title || '')}</p>`)
    : (reader.ctx.getRendered ? reader.ctx.getRendered(node.id, 'statement') : reader.ctx.render(node.statementBody));
  const el = document.createElement('div');
  el.className = 'reader-preview';
  el.style.setProperty('--reader-color', typeColor(reader.ctx.model, node.type));
  el.innerHTML = `
    <div class="reader-preview-head">
      <span>${escapeHtml(nodeTag(reader.ctx.model, node))}</span>
      <strong>${escapeHtml(node.title || node.id)}</strong>
      <button data-close-preview title="关闭">${ICON.close}</button>
    </div>
    <div class="reader-preview-body">${statement || '<p class="reader-muted">无正文。</p>'}</div>
    <div class="reader-preview-actions">
      <button data-preview-open="${escapeAttr(node.id)}">${ICON.arrowUpRight}<span>打开</span></button>
      <button data-preview-new="${escapeAttr(node.id)}">${ICON.plus}<span>新标签</span></button>
    </div>`;
  reader.el.appendChild(el);
  positionPreview(el, anchorEl);
  el.querySelector('[data-close-preview]')?.addEventListener('click', () => closePreview(reader));
  el.querySelector('[data-preview-open]')?.addEventListener('click', () => {
    navigate(reader, reader.activeId, nodePage(node.id));
    closePreview(reader);
    renderReader(reader);
  });
  el.querySelector('[data-preview-new]')?.addEventListener('click', () => {
    addNodeTab(reader, node.id);
    closePreview(reader);
    renderReader(reader);
  });
  reader.previewEl = el;
}

function positionPreview(el, anchorEl) {
  const ar = anchorEl.getBoundingClientRect();
  const host = document.body.getBoundingClientRect();
  const width = Math.min(430, Math.max(280, window.innerWidth - 24));
  el.style.width = `${width}px`;
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, ar.left + ar.width / 2 - width / 2));
  const topBelow = ar.bottom + 10;
  el.style.left = `${left - host.left}px`;
  el.style.top = `${Math.min(window.innerHeight - 230, Math.max(12, topBelow)) - host.top}px`;
}

function closePreview(reader) {
  reader.previewEl?.remove();
  reader.previewEl = null;
}

function openReaderCopyMenu(reader, anchorEl) {
  const tab = activeTab(reader);
  const node = tab?.kind === 'node' ? reader.ctx.model.nodeById.get(tab.nodeId) : null;
  if (!node) return;
  closeReaderCopyMenu(reader);
  const menu = document.createElement('div');
  menu.className = 'm-menu reader-copy-menu';
  [
    { label: '复制所有内容', mode: 'all' },
    { label: '复制标题', mode: 'title' },
  ].forEach((item) => {
    const row = document.createElement('div');
    row.className = 'm-menu-item';
    const button = document.createElement('button');
    button.className = 'mm-main';
    button.type = 'button';
    button.textContent = item.label;
    button.addEventListener('click', () => {
      closeReaderCopyMenu(reader);
      copyReaderNode(node, item.mode);
    });
    row.appendChild(button);
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  reader.copyMenu = menu;
  const close = (ev) => {
    if (!menu.contains(ev.target)) closeReaderCopyMenu(reader);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', close, true);
    reader.copyMenuClose = close;
  }, 0);
}

function closeReaderCopyMenu(reader) {
  if (reader.copyMenu) {
    reader.copyMenu.remove();
    reader.copyMenu = null;
  }
  if (reader.copyMenuClose) {
    document.removeEventListener('pointerdown', reader.copyMenuClose, true);
    reader.copyMenuClose = null;
  }
}

function bindReaderSelectionSurface(reader) {
  const schedule = (delay = 180) => {
    if (!window.matchMedia?.('(max-width: 760px)').matches) return;
    clearTimeout(reader.selectionTimer);
    reader.selectionTimer = setTimeout(() => {
      const sel = selectionInReader(reader);
      if (sel) showReaderSelectionMenu(reader, sel);
      else if (reader.selectionMenu) closeReaderSelectionMenu(reader);
      reader.selectionTimer = null;
    }, delay);
  };
  reader.selectionChangeHandler = () => schedule(260);
  document.addEventListener('selectionchange', reader.selectionChangeHandler);
  reader.el.addEventListener('mouseup', () => schedule(120), true);
  reader.el.addEventListener('touchend', () => schedule(120), true);
  reader.el.addEventListener('scroll', () => {
    if (!reader.selectionMenu) return;
    schedule(80);
  }, true);
  reader.el.addEventListener('copy', (e) => {
    const sel = selectionInReader(reader);
    if (!sel) return;
    const src = selectionSource(sel);
    if (src && e.clipboardData) {
      e.clipboardData.setData('text/plain', src);
      e.preventDefault();
    }
  }, true);
}

function selectionInReader(reader) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim() || !sel.rangeCount) return null;
  const nodeEl = (n) => (n?.nodeType === 1 ? n : n?.parentElement);
  const anchor = nodeEl(sel.anchorNode);
  const focus = nodeEl(sel.focusNode);
  const content = anchor?.closest?.('.reader-content');
  if (!content || !reader.el.contains(content) || !content.contains(focus)) return null;
  return sel;
}

function showReaderSelectionMenu(reader, sel) {
  const rect = selectionRect(sel);
  if (!rect) return;
  if (!reader.selectionMenu) {
    const menu = document.createElement('div');
    menu.className = 'card-simple-menu reader-selection-menu';
    const button = document.createElement('button');
    button.className = 'csm-btn';
    button.type = 'button';
    button.title = '复制选中';
    button.innerHTML = ICON.copy;
    button.addEventListener('click', () => {
      copyReaderSelection(window.getSelection());
      closeReaderSelectionMenu(reader);
    });
    menu.appendChild(button);
    document.body.appendChild(menu);
    reader.selectionMenu = menu;
  }
  positionReaderSelectionMenu(reader.selectionMenu, rect);
}

function selectionRect(sel) {
  const rects = sel.getRangeAt(0).getClientRects();
  const visible = [...rects].filter((r) => r.width > 1 && r.height > 1);
  return visible[visible.length - 1] || null;
}

function positionReaderSelectionMenu(menu, rect) {
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = rect.right;
  let y = rect.bottom + 6;
  if (x + mw > window.innerWidth - 6) x = window.innerWidth - mw - 6;
  if (y + mh > window.innerHeight - 6) y = rect.top - mh - 6;
  menu.style.left = `${Math.max(6, x)}px`;
  menu.style.top = `${Math.max(6, y)}px`;
}

function closeReaderSelectionMenu(reader) {
  if (reader.selectionMenu) {
    reader.selectionMenu.remove();
    reader.selectionMenu = null;
  }
}

async function copyReaderSelection(sel) {
  try {
    await navigator.clipboard.writeText(selectionSource(sel));
    toast('已复制');
  } catch {
    toast('复制失败', { type: 'error' });
  }
}

async function copyReaderNode(node, mode) {
  const text = mode === 'title'
    ? (node.title || node.id || '')
    : [node.title, node.statementBody, node.proofBody].filter(Boolean).join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(mode === 'title' ? '已复制标题' : '已复制内容');
  } catch {
    toast('复制失败', { type: 'error' });
  }
}

function bindScrollMemory(reader) {
  const scroller = scrollElement(reader);
  if (!scroller) return;
  scroller.addEventListener('scroll', () => {
    const tab = activeTab(reader);
    if (!tab) return;
    tab.scroll[pageKey(pageFromTab(tab))] = scroller.scrollTop;
    clearTimeout(reader.scrollTimer);
    reader.scrollTimer = setTimeout(() => persistState(reader), 180);
  }, { passive: true });
}

function scrollElement(reader) {
  if (window.matchMedia?.('(max-width: 760px)').matches) {
    return reader.el.querySelector('.reader-body');
  }
  return reader.el.querySelector('.reader-main') || reader.el.querySelector('.reader-library-page');
}

function saveScroll(reader) {
  const tab = activeTab(reader);
  const scroller = scrollElement(reader);
  if (tab && scroller) {
    tab.scroll[pageKey(pageFromTab(tab))] = scroller.scrollTop;
    persistState(reader);
  }
}

function restoreScroll(reader) {
  const tab = activeTab(reader);
  const scroller = scrollElement(reader);
  if (!tab || !scroller) return;
  scroller.scrollTop = tab.scroll?.[pageKey(pageFromTab(tab))] || 0;
}

function filteredNodes(reader, tab) {
  const q = (tab?.query || '').trim().toLowerCase();
  return reader.ctx.model.nodes
    .filter((n) => !q
      || n.id.toLowerCase().includes(q)
      || (n.title || '').toLowerCase().includes(q)
      || String(n.number || '').toLowerCase() === q
      || (n.typeLabel || n.type || '').toLowerCase().includes(q))
    .slice(0, 180);
}

function restoreState(reader) {
  try {
    const raw = localStorage.getItem(reader.storageKey);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const validTabs = Array.isArray(saved.tabs) ? saved.tabs.map((t) => sanitizeTab(reader, t)).filter(Boolean) : [];
    reader.tabs = validTabs;
    reader.activeId = validTabs.some((t) => t.id === saved.activeId) ? saved.activeId : validTabs[0]?.id || '';
    seq = Math.max(seq, ...validTabs.map((t) => Number(String(t.id).replace(/\D/g, '')) + 1).filter(Number.isFinite), 1);
  } catch {
    reader.tabs = [];
    reader.activeId = '';
  }
}

function sanitizeTab(reader, tab) {
  if (!tab || typeof tab !== 'object') return null;
  const next = createTab(tab.kind === 'node' ? nodePage(tab.nodeId) : libraryPage(tab.query || ''));
  next.id = typeof tab.id === 'string' ? tab.id : next.id;
  next.back = sanitizePages(reader, tab.back);
  next.forward = sanitizePages(reader, tab.forward);
  next.scroll = tab.scroll && typeof tab.scroll === 'object' ? { ...tab.scroll } : {};
  if (next.kind === 'node' && !reader.ctx.model.nodeById.has(next.nodeId)) return null;
  return next;
}

function sanitizePages(reader, pages) {
  if (!Array.isArray(pages)) return [];
  return pages.map((p) => {
    if (p?.kind === 'node' && reader.ctx.model.nodeById.has(p.nodeId)) return nodePage(p.nodeId);
    if (p?.kind === 'library') return libraryPage(p.query || '');
    return null;
  }).filter(Boolean);
}

function persistState(reader) {
  if (!reader.tabs.length) return;
  const tabs = reader.tabs.map((t) => ({
    id: t.id,
    kind: t.kind,
    nodeId: t.nodeId,
    query: t.query || '',
    back: t.back,
    forward: t.forward,
    scroll: t.scroll || {},
  }));
  localStorage.setItem(reader.storageKey, JSON.stringify({ activeId: reader.activeId, tabs }));
}

function parseRoutePage(value) {
  if (!value || value === 'library') return value === 'library' ? libraryPage() : null;
  if (value.startsWith('node:')) return nodePage(value.slice(5));
  return null;
}

function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
