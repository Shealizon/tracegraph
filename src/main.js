// =============================================================================
// main.js  —  项目入口、leading/main 路由与关系图状态机
// =============================================================================
import 'katex/dist/katex.min.css';
import './styles/app.css';
import './styles/modal.css';
import './styles/ai-panel.css';
import { buildModel } from './model/graph.js';
import { createRenderer } from './render/tex.js';
import { ForceGraph } from './view/forceGraph.js';
import { ModalManager } from './view/modal.js';
import { RefLayer } from './view/refLayer.js';
import { buildSidebar, buildZoomControl } from './ui/sidebar.js';
import { ICON } from './ui/icons.js';
import { getReaderRoute, openDetails, openReaderLibrary, openReaderRoute } from './view/detailsPage.js';
import { createTagMember, isLeafNode, memberKey, memberNode, memberType, normalizeTags } from './data/schema.js';
import { renderLeadingPage } from './view/leadingPage.js';
import { initProjectStore, listProjects, saveProject, setCurrentProjectId } from './project/store.js';
import { compileProject } from './project/projectAdapter.js';
import { downloadProject, goLeading, importGenericTex, importStructuredJson, openProjectConfigDialog } from './project/projectConfig.js';
import { choiceDialog, toast } from './ui/feedback.js';
import {
  normalizeProjectNotes, notePointerFromMember, notesForMember,
  reassignNotesFromMember, resolveNotePointer, stripEmbeddedNotes,
} from './data/notes.js';
import { initTooltips } from './ui/tooltip.js';
import { initCardMenus } from './ui/cardMenus.js';
import { annotationTextLengthToBoundary, markdownTextFromRange, normalizeSelectionForMath } from './view/annotation.js';
import { buildAiPanel } from './ui/aiPanel.js';
import { createNoteWindowController } from './ui/noteUi.js';
import { initSession, sessionSnapshot } from './cloud/session.js';
import { configureProjectSync, syncNow } from './cloud/sync.js';
import { renderAdminPage } from './cloud/adminPage.js';
import { hydrateCloudAiState } from './cloud/aiState.js';
import { downloadProjectData } from './debug/exportData.js';
import { debugCheckpoint, debugError, installDiagnostics } from './debug/diagnostics.js';

const runtimeDebugContext = { phase: 'boot', screen: '', projectId: '', projectCount: 0 };
installDiagnostics({ getContext: () => runtimeDebugContext });
debugCheckpoint('src/main.js', 'module-ready', { location: location.href }, { level: 'info' });
initTooltips();

init().catch((err) => {
  debugError('src/main.js', 'init-failed', err);
  console.error(err);
  document.body.innerHTML = `<pre style="padding:24px;color:#d66">启动失败：${escapeHtml(err?.message || err)}</pre>`;
});

async function init() {
  runtimeDebugContext.phase = 'initializing';
  debugCheckpoint('src/main.js', 'init-start');
  await initSession();
  let store = await initProjectStore();
  runtimeDebugContext.projectCount = store.projects.length;
  debugCheckpoint('src/main.js', 'project-store-ready', {
    projectCount: store.projects.length,
    currentProjectId: store.currentProjectId,
  });
  configureProjectSync(store.db);
  if (sessionSnapshot().user) {
    try {
      await syncNow();
      store = { ...store, projects: await listProjects(store.db) };
    } catch (error) { console.warn('initial cloud sync failed', error); }
  }
  const query = new URLSearchParams(location.search);
  const screen = query.get('screen') || 'leading';
  const projectId = query.get('project') || store.currentProjectId;
  Object.assign(runtimeDebugContext, { phase: 'routing', screen, projectId: projectId || '' });
  debugCheckpoint('src/main.js', 'route-selected', { screen, projectId });

  if (screen === 'admin') {
    await renderAdminPage();
    runtimeDebugContext.phase = 'ready';
    return;
  }

  if (screen === 'main' || screen === 'reader') {
    const project = store.projects.find((p) => p.id === projectId) || store.projects[0];
    if (project) {
      await hydrateCloudAiState(project.id);
      setCurrentProjectId(project.id);
      if (!location.hash && project.config?.viewState?.hash) {
        history.replaceState(null, '', `${location.pathname}?screen=main&project=${encodeURIComponent(project.id)}${project.config.viewState.hash}`);
      }
      startMain(store.db, project);
    } else {
      renderLeadingPage(store);
      runtimeDebugContext.phase = 'ready';
    }
  } else {
    renderLeadingPage(store);
    runtimeDebugContext.phase = 'ready';
  }
}

function startMain(db, project) {
  Object.assign(runtimeDebugContext, {
    phase: 'main-starting',
    projectId: project.id,
    projectName: project.name || '',
    documentCount: project.documents?.length || 0,
  });
  debugCheckpoint('src/main.js', 'main-start', {
    projectId: project.id,
    documentCount: project.documents?.length || 0,
  }, { level: 'info' });
  document.getElementById('leading-root')?.remove();
  document.getElementById('app').style.display = 'block';

  const model = buildModel(compileProject(project));
  runtimeDebugContext.nodeCount = model.nodes.length;
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
  const render = createRenderer({ macros: model.meta.macros, numberOf, kindOf, ownerOf, bodyFormat: model.meta.bodyFormat });

  const stageEl = document.getElementById('stage');
  const svgEl = document.getElementById('edges-layer');
  const nodesEl = document.getElementById('nodes-layer');
  const overlayEl = document.getElementById('overlay-layer');
  const tagsEl = document.getElementById('tag-layer');
  svgEl.innerHTML = '';
  nodesEl.innerHTML = '';
  overlayEl.innerHTML = '';
  if (tagsEl) tagsEl.innerHTML = '';

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
    cloud: sessionSnapshot(),
    model,
    render,
    numberOf,
    kindOf,
    ownerOf,
    graph: null,
    modals: null,
    refLayer: null,
    notes: normalizeProjectNotes(project.config?.notes, model.meta?.tags || model.tags || []),
    mode: initialState.mode || 'show-all',
    refsRaiseEnabled: initialState.refsRaiseEnabled ?? (localStorage.getItem('hg-refs-raise') !== '0'),
    // 主题模式：dark | light | system（跟随系统）
    themeMode: initialState.themeMode || localStorage.getItem('hg-theme-mode') || localStorage.getItem('hg-theme') || 'system',
    theme: 'dark',
    hidden: new Set(initialState.hidden),
    filterActive: initialState.types ? new Set(initialState.types) : null,
    sidebarCollapsed: initialState.sidebarCollapsed,
    openDetails: (nodeId, opts) => openDetails(ctx, nodeId, opts),
    openReaderLibrary: () => openReaderLibrary(ctx),
    goLeading,
    openProjectConfig: () => openProjectConfigDialog({ db, project, onSaved: () => location.reload() }),
    exportProject: () => downloadProject(project),
    exportProjectData: async () => {
      try {
        toast('正在整理项目全部数据…');
        await downloadProjectData(project);
        toast('项目全部数据已导出');
      } catch (error) {
        toast(`导出失败：${error?.message || error}`, { type: 'error' });
      }
    },
    importFile: async () => {
      // 直接弹文件选择器，按扩展名分发（.json → 结构化；.tex/.txt → 通用自动识别）
      const file = await pickImportFile();
      if (!file) return;
      const lower = file.name.toLowerCase();
      try {
        if (lower.endsWith('.json')) await importStructuredJson(db, project, file);
        else if (lower.endsWith('.tex') || lower.endsWith('.txt')) await importGenericTex(db, project, file);
        else { toast('暂不支持该格式，请选择 .json / .tex / .txt', { type: 'error' }); return; }
        location.reload();
      } catch (e) { toast('导入失败：' + (e?.message || e), { type: 'error' }); }
    },
  };
  runtimeDebugContext.phase = 'ready';

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

  // ---- 标签（持久化 + 打标模式 + 标签筛选）----
  ctx.tagEditing = null;       // 正在编辑成员的 tagId（打标模式）
  ctx.tagFilter = new Set();   // 启用了「仅看此标签」的 tagId 集合
  ctx.persistTags = (tags) => {
    const normalizedTags = stripEmbeddedNotes(normalizeTags(tags));
    ctx.notes = (ctx.notes || []).map((note) => resolveNotePointer(note, normalizedTags) ? note : { ...note, tagPointer: null });
    project.config = { ...(project.config || {}), tags: normalizedTags, notes: ctx.notes };
    ctx.graph && ctx.graph.setTags(normalizedTags);
    // 标签/批注刷新只更新 tag-layer，但卡片正文的 DOM 可能在同一帧
    // 发生变化；显式重建两类连线，避免边层停留在旧的可见集合或旧锚点。
    ctx.graph?._renderEdges?.();
    ctx.refLayer?.refreshRelations?.();
    saveProject(db, project).catch((e) => console.warn('save tags failed', e));
    ctx.rebuildTagPanel && ctx.rebuildTagPanel();
    ctx.refreshMainpathButton && ctx.refreshMainpathButton();
    ctx.applyTagFilter && ctx.applyTagFilter();
    ctx.updateTagHint && ctx.updateTagHint();
    ctx.modals && ctx.modals.refreshAllMarks && ctx.modals.refreshAllMarks();
    ctx._reader?.refreshMarks?.();
  };
  ctx.getNotes = () => ctx.notes || [];
  ctx.notesForMember = (tag, member) => notesForMember(ctx.notes, tag, member);
  ctx.persistNotes = (notes) => {
    ctx.notes = normalizeProjectNotes(notes, ctx.graph?.getTags?.() || []);
    project.config = { ...(project.config || {}), notes: ctx.notes };
    saveProject(db, project).catch((e) => console.warn('save notes failed', e));
    ctx.rebuildTagPanel?.();
    ctx.modals?.refreshAllMarks?.();
    ctx._reader?.refreshMarks?.();
    ctx.graph?._renderTagChips?.();
  };
  ctx.requestDeleteTagMember = async (tagId, targetMember) => {
    const tag = (ctx.graph.getTags() || []).find((item) => item.id === tagId);
    const member = tag?.members?.find((item) => memberKey(item) === memberKey(targetMember));
    if (!tag || !member) return false;
    const notes = ctx.notesForMember(tag, member);
    let mode = 'delete';
    if (notes.length) {
      mode = await choiceDialog({
        title: '删除该标注',
        message: `此标注附有 ${notes.length} 条笔记。请选择笔记的处理方式。`,
        cancelValue: 'cancel',
        className: 'confirm-member-delete',
        actions: [
          { value: 'delete', label: '删除标签并同时删除所有笔记', tone: 'danger' },
          ...(memberType(member) === 'span' ? [{ value: 'move-to-node', label: '删除标签并将所有笔记归属到节点' }] : []),
          { value: 'cancel', label: '取消删除', autofocus: true },
        ],
      });
      if (mode === 'cancel') return false;
    }
    const tags = ctx.graph.getTags().map((item) => ({ ...item, members: [...item.members] }));
    const nextTag = tags.find((item) => item.id === tag.id);
    const targetIndex = nextTag.members.findIndex((item) => memberKey(item) === memberKey(member));
    if (targetIndex < 0) return false;
    let nextPointer = null;
    if (mode === 'move-to-node') {
      let nodeMember = nextTag.members.find((item) => memberType(item) === 'node' && memberNode(item) === memberNode(member));
      if (!nodeMember) {
        nodeMember = createTagMember(nextTag, { node: memberNode(member), type: 'node' });
        nextTag.members.push(nodeMember);
      }
      nextPointer = notePointerFromMember(nextTag, nodeMember);
    }
    nextTag.members.splice(targetIndex, 1);
    const noteIds = new Set(notes.map((note) => note.id));
    ctx.notes = mode === 'delete'
      ? ctx.notes.filter((note) => !noteIds.has(note.id))
      : reassignNotesFromMember(ctx.notes, tag, member, nextPointer);
    ctx.persistTags(tags);
    return true;
  };
  // 跳转到成员：node 聚焦；span/pos 打开卡片并滚动到该处
  ctx.jumpToMember = (member) => {
    const nodeId = memberNode(member); const n = ctx.model.nodeById.get(nodeId); if (!n) return;
    if (n._userHidden) ctx.unhideNode(nodeId);
    if (!ctx.modals.isOpen(nodeId)) ctx.modals.openFromNode(n);
    ctx.graph.focusNode(nodeId, ctx.graph.getZoomScale());
    if (!member || typeof member === 'string' || memberType(member) === 'node') return;
    setTimeout(() => {
      const rec = ctx.modals.open.get(nodeId); if (!rec) return;
      const body = rec.el.querySelector('.modal-body'); if (!body) return;
      if (member.type === 'span') {
        if (member.section === 'proof' && rec.setProofCollapsed) rec.setProofCollapsed(false);
        const range = ctx.modals._rangeFromMember(body, member);
        if (range) { const r = range.getBoundingClientRect(); const br = body.getBoundingClientRect(); body.scrollTop += (r.top - br.top) - body.clientHeight / 2; }
      } else if (member.type === 'pos') {
        const range = member.start != null ? ctx.modals._collapsedRangeFromMember(body, member) : null;
        if (range) {
          const r = range.getBoundingClientRect(); const br = body.getBoundingClientRect();
          body.scrollTop += (r.top - br.top) - body.clientHeight / 2;
        } else {
          body.scrollTop = (member.y || 0) * body.scrollHeight - body.clientHeight / 2;
        }
      }
    }, 140);
  };
  ctx.tagInsertAt = null; // 插入模式：在该下标处插入后续点击的节点（3->[a,b,c]->4）
  ctx.toggleNodeTag = (tagId, nodeId) => {
    const tags = (ctx.graph.getTags() || []).map((t) => ({ ...t, members: [...t.members] }));
    const t = tags.find((x) => x.id === tagId);
    if (!t) return;
    const i = t.members.findIndex((x) => memberType(x) === 'node' && memberNode(x) === nodeId); // 仅匹配整卡片成员
    if (ctx.tagInsertAt != null && ctx.tagEditing === tagId) {
      // 插入模式：移到指定位置（已存在则先移除），下次插入位置 +1，实现连续插入
      let at = ctx.tagInsertAt;
      if (i >= 0) { t.members.splice(i, 1); if (i < at) at -= 1; }
      at = Math.max(0, Math.min(at, t.members.length));
      t.members.splice(at, 0, nodeId);
      ctx.tagInsertAt = at + 1;
    } else if (i >= 0) t.members.splice(i, 1);
    else t.members.push(createTagMember(t, nodeId)); // 追加：点击顺序即步骤顺序
    ctx.noteRecentTag(tagId);
    ctx.persistTags(tags);
  };
  ctx.activateNode = (n) => {
    if (ctx.tagEditing) { ctx.toggleNodeTag(ctx.tagEditing, n.id); return; }
    ctx.aiPanel?.setSelectedNode(n.id);
    ctx.modals.openFromNode(n);
  };
  // 最近使用过的标签（LRU），供 simple-menu / 右键菜单的「常用三个标签」
  ctx._recentTags = [];
  ctx.noteRecentTag = (tagId) => { if (tagId) ctx._recentTags = [tagId, ...ctx._recentTags.filter((x) => x !== tagId)]; };
  ctx.commonTags = (n = 3) => {
    const tags = ctx.graph.getTags ? ctx.graph.getTags() : [];
    const byId = new Map(tags.map((t) => [t.id, t]));
    const out = [];
    for (const id of ctx._recentTags) { const t = byId.get(id); if (t) out.push(t); if (out.length >= n) break; }
    for (const t of tags) { if (out.length >= n) break; if (!out.includes(t)) out.push(t); }
    return out.slice(0, n);
  };
  // 追加任意成员（node 字符串 / span / pos 对象）；可指定插入下标
  ctx.addMember = (tagId, member, index = null) => {
    if (!member) return;
    ctx.persistTags(ctx.graph.getTags().map((t) => {
      if (t.id !== tagId) return t;
      const ms = [...t.members];
      const at = index == null ? ms.length : Math.max(0, Math.min(index, ms.length));
      ms.splice(at, 0, createTagMember(t, member));
      return { ...t, members: ms };
    }));
    ctx.noteRecentTag(tagId);
  };
  // 选区 → span 成员（记录 section + 字符偏移 + 原文，供后续重建 Range）
  ctx.spanFromSelection = (body, nodeId, sel) => {
    normalizeSelectionForMath(sel, body);
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const proof = startEl && startEl.closest('.proof-wrap');
    const container = proof || (startEl && startEl.closest('.statement')) || body;
    const off = (n, o) => annotationTextLengthToBoundary(container, n, o);
    const start = off(range.startContainer, range.startOffset);
    const end = off(range.endContainer, range.endOffset);
    const text = markdownTextFromRange(range);
    if (end <= start || !text.trim()) return null;
    return { node: nodeId, type: 'span', section: proof ? 'proof' : 'statement', start, end, text, offsetMode: 'annotation-md' };
  };
  // 打标模式：氛围（页面变化）+ 底部提示 + Enter 完成
  ctx.setTagEditing = (tagId, insertAt = null) => {
    const wasOff = !ctx.tagEditing;
    if (tagId && wasOff) ctx._tagSnapshot = (ctx.graph.getTags() || []).map((t) => ({ ...t, members: [...t.members] })); // 进入时快照，供「取消」回滚
    if (!tagId) ctx._tagSnapshot = null;
    ctx.tagEditing = tagId || null;
    ctx.tagInsertAt = tagId ? insertAt : null;
    const appEl = document.getElementById('app');
    appEl.classList.toggle('tag-editing-mode', !!tagId);
    if (ctx._tagHint) { ctx._tagHint.remove(); ctx._tagHint = null; ctx._tagHintInfo = null; }
    if (tagId) {
      const t = (ctx.graph.getTags() || []).find((x) => x.id === tagId);
      appEl.style.setProperty('--tag-edit-color', t?.color || '#ff9e64'); // 氛围渐变用当前标签色
      const hint = document.createElement('div');
      hint.className = 'tag-edit-hint';
      const info = document.createElement('span'); info.className = 'teh-info';
      const done = document.createElement('button'); done.className = 'teh-btn teh-done'; done.textContent = '完成';
      done.addEventListener('click', () => ctx.setTagEditing(null));
      const cancel = document.createElement('button'); cancel.className = 'teh-btn teh-cancel'; cancel.textContent = '取消';
      cancel.addEventListener('click', () => ctx.cancelTagEditing());
      hint.appendChild(info); hint.appendChild(done); hint.appendChild(cancel);
      appEl.appendChild(hint);
      ctx._tagHint = hint; ctx._tagHintInfo = info;
      ctx.updateTagHint();
    }
    ctx.rebuildTagPanel && ctx.rebuildTagPanel();
  };
  // 底部提示：添加 [色点/方框(有序写当前序号)] 标签 / 删除标签；序号随插入位置实时更新
  ctx.updateTagHint = () => {
    if (!ctx._tagHintInfo || !ctx.tagEditing) return;
    const t = (ctx.graph.getTags() || []).find((x) => x.id === ctx.tagEditing);
    if (!t) return;
    const ordered = t.kind === 'ordered';
    const num = (ctx.tagInsertAt != null ? ctx.tagInsertAt : (t.members || []).length) + 1;
    const sw = ordered
      ? `<span class="teh-swatch square" style="--tc:${t.color}">${num}</span>`
      : `<span class="teh-swatch" style="--tc:${t.color}"></span>`;
    ctx._tagHintInfo.innerHTML = `添加 ${sw} 标签 / 删除标签`;
  };
  // 取消：回滚到进入打标前的快照并退出
  ctx.cancelTagEditing = () => {
    const snap = ctx._tagSnapshot;
    ctx._tagSnapshot = null;
    ctx.tagEditing = null; ctx.tagInsertAt = null;
    document.getElementById('app').classList.remove('tag-editing-mode');
    if (ctx._tagHint) { ctx._tagHint.remove(); ctx._tagHint = null; }
    if (snap) ctx.persistTags(snap); else ctx.rebuildTagPanel && ctx.rebuildTagPanel();
  };
  // 打标模式：卡片正文交互——拖选文字/公式→span 标记；单击→整卡片标记
  const cardBodyAt = (target) => {
    for (const [nodeId, rec] of ctx.modals.open) {
      if (rec.el.contains(target)) { const body = rec.el.querySelector('.modal-body'); return { nodeId, body, inBody: !!(body && body.contains(target)) }; }
    }
    return null;
  };
  const normalizeCardSelection = () => {
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const nodeEl = (n) => (n?.nodeType === 1 ? n : n?.parentElement);
    const anchor = nodeEl(sel.anchorNode);
    const focus = nodeEl(sel.focusNode);
    const body = anchor?.closest?.('.modal-body');
    if (body && body.contains(focus)) normalizeSelectionForMath(sel, body);
  };
  // selectionchange fires during the drag, so formulas snap to their atomic
  // boundary while the selection is being made, not only on mouseup.
  document.addEventListener('selectionchange', normalizeCardSelection, true);
  let pressX = 0, pressY = 0, dragged = false, spanHandled = false, clickTimer = null;
  overlayEl.addEventListener('pointerdown', (e) => { if (!ctx.tagEditing) return; pressX = e.clientX; pressY = e.clientY; dragged = false; spanHandled = false; }, true);
  overlayEl.addEventListener('pointermove', (e) => { if (ctx.tagEditing && Math.hypot(e.clientX - pressX, e.clientY - pressY) > 5) dragged = true; }, true);
  overlayEl.addEventListener('mouseup', (e) => {
    if (!ctx.tagEditing) return;
    const c = cardBodyAt(e.target); if (!c || !c.inBody) return;
    const sel = window.getSelection();
    if (dragged && sel && !sel.isCollapsed && c.body.contains(sel.anchorNode)) {
      const span = ctx.spanFromSelection(c.body, c.nodeId, sel);
      if (span) { ctx.addMember(ctx.tagEditing, span); spanHandled = true; sel.removeAllRanges(); }
    }
  }, true);
  overlayEl.addEventListener('click', (e) => {
    if (!ctx.tagEditing || !ctx.modals) return;
    if (e.target.closest('.m-btn, button, a, input, .texref, .m-sub')) return;
    const c = cardBodyAt(e.target); if (!c) return;
    e.stopPropagation(); e.preventDefault();
    if (spanHandled) { spanHandled = false; return; }      // 刚完成 span，不再切整卡片
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => ctx.toggleNodeTag(ctx.tagEditing, c.nodeId), 230); // 延迟，等可能的双击
  }, true);
  overlayEl.addEventListener('dblclick', (e) => {
    if (!ctx.tagEditing) return;
    const c = cardBodyAt(e.target); if (!c || !c.inBody) return;
    e.stopPropagation(); e.preventDefault();
    clearTimeout(clickTimer); // 双击公式/单词时不切换整卡片标签
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !c.body.contains(sel.anchorNode) || !c.body.contains(sel.focusNode)) return;
    const span = ctx.spanFromSelection(c.body, c.nodeId, sel);
    if (span) {
      ctx.addMember(ctx.tagEditing, span);
      sel.removeAllRanges();
    }
  }, true);
  // Enter 完成 / Esc 取消（输入框聚焦时不触发）
  window.addEventListener('keydown', (e) => {
    if (!ctx.tagEditing) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'Enter') { e.preventDefault(); ctx.setTagEditing(null); }
    else if (e.key === 'Escape') { e.preventDefault(); ctx.cancelTagEditing(); }
  });
  // 双击页面空白处（非节点/卡片/贴片）→ 完成并退出打标
  stageEl.addEventListener('dblclick', (e) => {
    if (!ctx.tagEditing) return;
    if (e.target.closest('#nodes-layer .node, #overlay-layer > *, #tag-layer .tag-chip-cluster')) return;
    e.preventDefault();
    ctx.setTagEditing(null);
  });

  const graph = new ForceGraph(model, {
    stageEl,
    svgEl,
    nodesEl,
    overlayEl,
    tagsEl,
    storageKey: `hg-pos-${project.id}`,
    initialTransform: initialState.zoom, // 首帧即用保存的视角，避免先默认缩放再跳转
    onNodeActivate: (n) => ctx.activateNode(n),
  });
  ctx.graph = graph;
  graph.ctx = ctx;
  ctx.noteWindows = createNoteWindowController(ctx);
  if (initialState.force) {
    if (Number.isFinite(initialState.force.center)) graph.setForce('center', initialState.force.center);
    if (Number.isFinite(initialState.force.charge)) graph.setForce('charge', initialState.force.charge);
    if (Number.isFinite(initialState.force.link)) graph.setForce('link', initialState.force.link);
  }
  if (Number.isFinite(initialState.edgeWidth)) graph.setEdgeWidth(initialState.edgeWidth);

  ctx.modals = new ModalManager(ctx, { overlayEl, stageEl });
  ctx.refLayer = new RefLayer(ctx, { overlayEl, stageEl });
  initCardMenus(ctx); // 选中文字 simple-menu + 右键菜单
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
  buildReaderLauncher(ctx, stageEl);
  ctx.aiPanel = buildAiPanel(ctx);

  // ---- Deep-link：URL hash 恢复 / 写回 ----
  ctx.writeHash = () => {
    const ids = ctx.modals ? [...ctx.modals.open.keys()] : [];
    const readerRoute = getReaderRoute(ctx);
    const params = new URLSearchParams();
    if (ids.length) params.set('open', ids.join(','));
    if (readerRoute) {
      params.set('reader', '1');
      params.set('readerPage', readerRoute.page);
      if (readerRoute.chain?.length) params.set('readerChain', readerRoute.chain.join('>'));
    }
    params.set('mode', ctx.mode);
    if (ctx.filterActive) params.set('types', [...ctx.filterActive].join(','));
    params.set('hidden', [...(ctx.hidden || [])].join(','));
    if (ctx.graph) params.set('force', ['center', 'charge', 'link'].map((k) => fmtNumber(ctx.graph.getForce(k))).join(','));
    if (ctx.graph) params.set('edge', fmtNumber(ctx.graph.getEdgeWidth()));
    if (ctx.modals) params.set('modal', String(ctx.modals.getWidth()));
    params.set('refs', ctx.refsRaiseEnabled ? '1' : '0');
    params.set('theme', ctx.themeMode);
    params.set('sidebar', ctx.sidebarCollapsed ? '0' : '1');
    // 缩放/平移视角
    if (ctx.graph) { const t = ctx.graph.transform; params.set('zoom', [fmtNumber(t.k), Math.round(t.x), Math.round(t.y)].join(',')); }
    // 已锁定（pin）的卡片 / 节点
    const pins = model.nodes.filter((n) => n.pinned).map((n) => n.id);
    if (pins.length) params.set('pin', pins.join(','));
    const str = params.toString();
    const screen = readerRoute ? 'reader' : 'main';
    history.replaceState(null, '', `${location.pathname}?screen=${screen}&project=${encodeURIComponent(project.id)}${str ? `#${str}` : ''}`);
    scheduleProjectStateSave();
  };

  const state = initialState;
  // 渐进恢复已展开卡片（恢复期间不记录撤销）：
  // 布局在构造时已预热稳定，首帧后即逐帧加入卡片——卡片几乎紧随节点出现，
  // 多卡片分帧渲染避免一次性卡顿，配合 CSS 淡入消除"先节点、稍后突变出卡片"的跳变。
  ctx._restoring = true;
  const restoreOpen = () => {
    const ids = state.open || [];
    let i = 0;
    const step = () => {
      if (i < ids.length) {
        const id = ids[i];
        const n = model.nodeById.get(id);
        if (n) ctx.modals.openFromNode(n, { x: (i - (ids.length - 1) / 2) * 460, y: 0 });
        i += 1;
        requestAnimationFrame(step); // 逐帧渐进添加
        return;
      }
      // 恢复 pin（卡片/节点锁定 + 光晕）
      for (const id of (state.pin || [])) { const n = model.nodeById.get(id); if (n && !n.pinned) ctx.modals.togglePin(n); }
      if (state.mode && state.mode !== 'show-all' && ctx.setMode) ctx.setMode(state.mode);
      // 恢复视角：有保存的缩放/平移则精确还原；否则沿用自动聚焦
      if (state.zoom && Number.isFinite(state.zoom.k)) {
        graph.setTransform(state.zoom.k, state.zoom.x, state.zoom.y);
      } else {
        if (ids.length === 1) graph.focusNode(ids[0], 0.85);
        if (state.focus) graph.focusNode(state.focus, 1.0);
      }
      if (state.readerOpen) openReaderRoute(ctx, { page: state.readerPage, chain: state.readerChain });
      ctx.writeHash && ctx.writeHash();
      ctx._restoring = false;
    };
    step();
  };
  // 等两帧（布局已稳定）再开始，避免与首帧渲染争用
  requestAnimationFrame(() => requestAnimationFrame(restoreOpen));

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

function buildReaderLauncher(ctx, stageEl) {
  let btn = stageEl.querySelector('.reader-launcher');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'reader-launcher';
    btn.type = 'button';
    stageEl.appendChild(btn);
  }
  btn.innerHTML = ICON.listOrdered;
  btn.title = '打开阅读列表';
  btn.setAttribute('aria-label', '打开阅读列表');
  btn.addEventListener('click', () => ctx.openReaderLibrary && ctx.openReaderLibrary());
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const q = new URLSearchParams(location.search);
  const forceParts = (h.get('force') || '').split(',').map((v) => Number(v));
  const zoomParts = (h.get('zoom') || '').split(',').map((v) => Number(v));
  return {
    open: parseList(h.get('open')),
    mode: h.get('mode') || 'show-all',
    focus: h.get('focus') || '',
    types: h.has('types') ? parseList(h.get('types')) : null,
    hidden: parseList(h.get('hidden')),
    force: h.has('force') ? { center: forceParts[0], charge: forceParts[1], link: forceParts[2] } : null,
    edgeWidth: h.has('edge') ? Number(h.get('edge')) : null,
    modalWidth: h.has('modal') ? Number(h.get('modal')) : null,
    refsRaiseEnabled: h.has('refs') ? h.get('refs') !== '0' : null,
    themeMode: h.get('theme') || '',
    sidebarCollapsed: h.has('sidebar') ? h.get('sidebar') === '0' : null,
    readerOpen: q.get('screen') === 'reader' || h.get('reader') === '1',
    readerPage: h.get('readerPage') || '',
    readerChain: parseChain(h.get('readerChain')),
    zoom: h.has('zoom') ? { k: zoomParts[0], x: zoomParts[1], y: zoomParts[2] } : null,
    pin: parseList(h.get('pin')),
  };
}

function parseList(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function parseChain(value) {
  return (value || '').split('>').map((s) => s.trim()).filter(Boolean);
}

function fmtNumber(value) {
  return Number(value).toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pickImportFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.tex,.txt,application/json,text/plain';
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}
