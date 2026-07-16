import { normalizeProject, uniqueId } from '../project/projectAdapter.js';
import { edgeCountOf } from '../data/adapter.js';
import { deleteProject, listProjects, saveProject, setCurrentProjectId } from '../project/store.js';
import { downloadProject, importGenericTex, importStructuredJson, openProjectConfigDialog, projectMainUrl } from '../project/projectConfig.js';
import { ICON } from '../ui/icons.js';
import { toast } from '../ui/feedback.js';
import { mountAccountControls } from '../cloud/accountUi.js';
import { onSyncChange } from '../cloud/sync.js';
import { serverApi } from '../cloud/api.js';
import { sessionSnapshot } from '../cloud/session.js';
import { downloadApplicationData } from '../debug/exportData.js';

let releaseSyncListener = null;

const THEME_MODES = [
  { mode: 'dark', icon: 'moon', title: '深色' },
  { mode: 'system', icon: 'monitor', title: '跟随系统' },
  { mode: 'light', icon: 'sun', title: '浅色' },
];

export function renderLeadingPage({ db, projects, currentProjectId }) {
  applyStoredTheme();
  document.getElementById('app').style.display = 'none';
  let root = document.getElementById('leading-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'leading-root';
    document.body.appendChild(root);
  }
  const current = projects.find((p) => p.id === currentProjectId) || projects[0];
  root.innerHTML = `
    <div class="leading-page">
      <header class="leading-topbar">
        <div class="leading-brand">
          <h1>Entail</h1>
          <span>${projects.length} 个项目</span>
        </div>
        <div class="leading-account-actions"><button class="btn" data-export-all>${ICON.download}<span>导出全部数据</span></button><div data-leading-theme></div><div data-account></div></div>
      </header>
      <button class="codex-auth-banner" data-codex-banner hidden>
        <span class="codex-auth-banner-dot"></span>
        <span><strong>服务器 Codex 尚未登录</strong><small>${sessionSnapshot().user?.role === 'admin' ? '前往管理员面板完成授权' : '请联系管理员完成授权'}</small></span>
        <span class="codex-auth-banner-arrow">→</span>
      </button>
      <section class="leading-panel">
        <div class="project-cards">
          ${projects.map((project) => projectCard(project, project.id === current?.id)).join('')}
          <button class="project-card project-card-create" data-create>
            <div class="create-plus">${ICON.plus}</div>
            <div>新建项目</div>
          </button>
        </div>
      </section>
    </div>`;
  root.querySelector('[data-leading-theme]').appendChild(buildLeadingThemeSwitch());
  mountAccountControls(root.querySelector('[data-account]'), { onChanged: () => location.reload() });
  mountCodexLoginBanner(root);
  root.querySelector('[data-export-all]').addEventListener('click', async () => {
    try {
      toast('正在整理全部项目、对话和工作区文件…');
      await downloadApplicationData(db);
      toast('全部数据已导出');
    } catch (error) {
      toast(`导出失败：${error?.message || error}`, { type: 'error' });
    }
  });

  // 整卡可点击打开（操作按钮内部已 stopPropagation）
  root.querySelectorAll('[data-card]').forEach((card) => card.addEventListener('click', () => {
    setCurrentProjectId(card.dataset.card);
    location.href = projectMainUrl(card.dataset.card);
  }));

  const refresh = async (selectId = null) => {
    const nextProjects = await listProjects(db);
    const nextId = selectId || currentProjectId || nextProjects[0]?.id;
    if (nextId) setCurrentProjectId(nextId);
    renderLeadingPage({ db, projects: nextProjects, currentProjectId: nextId });
  };
  releaseSyncListener?.();
  let renderedSyncAt = '';
  releaseSyncListener = onSyncChange((state) => {
    if (!state.syncing && state.lastSyncedAt && state.lastSyncedAt !== renderedSyncAt) {
      renderedSyncAt = state.lastSyncedAt;
      refresh();
    }
  });
  root.querySelector('[data-create]').addEventListener('click', async () => {
    const now = new Date().toISOString();
    const project = normalizeProject({
      id: uniqueId('project'),
      name: '', // 留空 = 尚未命名：配置弹窗显示占位名，保存时落实
      createdAt: now,
      updatedAt: now,
      config: { enabledDocumentIds: [], disabledNodeIds: [], disabledRelationKeys: [], viewState: {} },
      documents: [],
    });
    const saved = await saveProject(db, project);
    setCurrentProjectId(saved.id);
    openProjectConfigDialog({ db, project: saved, onSaved: (p) => refresh(p?.id || saved.id) });
  });

  // 拖拽文件到引导页：自动新建项目并导入（标题取第一个文件名）
  const page = root.querySelector('.leading-page');
  page.addEventListener('dragover', (ev) => { ev.preventDefault(); page.classList.add('drag-over'); });
  page.addEventListener('dragleave', (ev) => { if (ev.target === page) page.classList.remove('drag-over'); });
  page.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    page.classList.remove('drag-over');
    const files = ev.dataTransfer?.files;
    if (!files || !files.length) return;
    const saved = await importFilesAsNewProject(db, files);
    if (saved) {
      setCurrentProjectId(saved.id);
      openProjectConfigDialog({ db, project: saved, onSaved: (p) => refresh(p?.id || saved.id) });
    }
  });

  root.querySelectorAll('[data-docinfo]').forEach((btn) => {
    btn.addEventListener('click', (ev) => ev.stopPropagation());
    btn.addEventListener('mouseenter', () => { const p = projects.find((x) => x.id === btn.dataset.docinfo); if (p) showDocTip(btn, p); });
    btn.addEventListener('mouseleave', hideDocTip);
  });
  root.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setCurrentProjectId(btn.dataset.open);
    location.href = projectMainUrl(btn.dataset.open);
  }));
  root.querySelectorAll('[data-config]').forEach((btn) => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const project = projects.find((p) => p.id === btn.dataset.config);
    if (project) openProjectConfigDialog({ db, project, onSaved: (p) => refresh(p?.id || project.id) });
  }));
  root.querySelectorAll('[data-export]').forEach((btn) => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const project = projects.find((p) => p.id === btn.dataset.export);
    if (project) downloadProject(project);
  }));
  root.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    closeDeletePopovers(root);
    if (projects.length <= 1) { showDeletePopover(btn, '至少保留一个项目。'); return; }
    const project = projects.find((p) => p.id === btn.dataset.delete);
    if (!project) return;
    showDeletePopover(btn, `删除「${project.name}」？`, async () => {
      await deleteProject(db, project.id);
      refresh();
    });
  }));
}

async function mountCodexLoginBanner(root) {
  const banner = root.querySelector('[data-codex-banner]');
  try {
    const status = await serverApi.codexStatus();
    if (!root.isConnected || status.authenticated || !status.enabled) return;
    banner.hidden = false;
    if (sessionSnapshot().user?.role === 'admin') {
      banner.addEventListener('click', () => { location.href = `${location.pathname}?screen=admin#codex`; });
    } else {
      banner.classList.add('is-static');
      banner.disabled = true;
    }
  } catch { /* server unavailable: keep the local-first home page uncluttered */ }
}

// 拖拽导入：新建空项目，按后缀逐个导入；名称留默认（弹窗据首个文件名提示），返回最终项目
async function importFilesAsNewProject(db, files) {
  const valid = [...files].filter((f) => /\.(json|tex|txt)$/i.test(f.name));
  if (!valid.length) { toast('仅支持 .json / .tex / .txt 文件'); return null; }
  const now = new Date().toISOString();
  let project = await saveProject(db, normalizeProject({
    id: uniqueId('project'),
    name: '新项目',
    createdAt: now,
    updatedAt: now,
    config: { enabledDocumentIds: [], disabledNodeIds: [], disabledRelationKeys: [], viewState: {} },
    documents: [],
  }));
  for (const f of valid) {
    try {
      if (/\.json$/i.test(f.name)) project = await importStructuredJson(db, project, f);
      else project = await importGenericTex(db, project, f);
    } catch (e) { toast(`「${f.name}」导入失败：` + (e?.message || e), { type: 'error' }); }
  }
  return project;
}

function projectCard(project, active) {
  const docs = project.documents || [];
  const enabled = new Set(project.config?.enabledDocumentIds || docs.map((d) => d.id));
  let nodes = 0, rels = 0;
  for (const d of docs) if (enabled.has(d.id)) { nodes += (d.graph?.nodes || []).length; rels += edgeCountOf(d.graph); }
  const updated = formatDate(project.updatedAt);
  const displayName = project.name || docs[0]?.name || '新项目'; // 尚未命名时回退到首个文件名/占位
  const syncState = project.sync?.state === 'synced' ? 'cloud' : project.sync?.location === 'cloud' ? 'pending' : 'local';
  const syncLabel = syncState === 'cloud' ? '云端' : syncState === 'pending' ? '待同步' : '仅本地';
  return `
    <article class="project-card${active ? ' active' : ''}" data-card="${escapeAttr(project.id)}" role="button" tabindex="0" title="打开项目">
      <div class="project-card-top">
        <h3>${escapeHtml(displayName)}</h3><span class="project-location is-${syncState}"><i></i>${syncLabel}</span>
      </div>
      <p class="project-card-meta">${nodes} 节点 · ${rels} 关系 · ${docs.length} 文件</p>
      <div class="project-card-foot">
        <span class="pc-updated">${updated ? `更新于 ${updated}` : ''}</span>
        <div class="project-card-actions">
          ${docs.length ? `<button class="icon-btn" title="文档信息" data-docinfo="${escapeAttr(project.id)}">${ICON.info}</button>` : ''}
          <button class="icon-btn" title="打开" data-open="${escapeAttr(project.id)}">${ICON.play}</button>
          <button class="icon-btn" title="配置" data-config="${escapeAttr(project.id)}">${ICON.settings}</button>
          <button class="icon-btn" title="导出项目结构" data-export="${escapeAttr(project.id)}">${ICON.download}</button>
          <button class="icon-btn icon-btn--danger" title="删除" data-delete="${escapeAttr(project.id)}">${ICON.trash}</button>
        </div>
      </div>
    </article>`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildLeadingThemeSwitch() {
  const wrap = document.createElement('div');
  wrap.className = 'segmented';
  wrap.setAttribute('role', 'radiogroup');
  const mode = localStorage.getItem('hg-theme-mode') || localStorage.getItem('hg-theme') || 'system';
  const sync = () => {
    const nextMode = localStorage.getItem('hg-theme-mode') || 'system';
    wrap.querySelectorAll('[data-theme-mode]').forEach((b) => b.classList.toggle('active', b.dataset.themeMode === nextMode));
  };
  for (const item of THEME_MODES) {
    const b = document.createElement('button');
    b.className = 'seg';
    b.type = 'button';
    b.title = item.title;
    b.setAttribute('aria-label', item.title);
    b.dataset.themeMode = item.mode;
    b.innerHTML = ICON[item.icon] || '';
    b.addEventListener('click', () => {
      localStorage.setItem('hg-theme-mode', item.mode);
      applyStoredTheme();
      sync();
    });
    wrap.appendChild(b);
  }
  localStorage.setItem('hg-theme-mode', mode);
  sync();
  return wrap;
}

function applyStoredTheme() {
  const mode = localStorage.getItem('hg-theme-mode') || localStorage.getItem('hg-theme') || 'system';
  const theme = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
  document.documentElement.setAttribute('data-theme', theme);
}

function showDeletePopover(anchor, text, onConfirm = null) {
  const card = anchor.closest('.project-card');
  const pop = document.createElement('div');
  pop.className = 'delete-popover';
  pop.innerHTML = `<span>${escapeHtml(text)}</span>${onConfirm ? '<button data-confirm>删除</button><button data-cancel>取消</button>' : '<button data-cancel>知道了</button>'}`;
  card.appendChild(pop);
  pop.addEventListener('click', (ev) => ev.stopPropagation()); // 阻止冒泡到整卡，避免误进入项目
  pop.querySelector('[data-cancel]').addEventListener('click', () => pop.remove());
  const confirm = pop.querySelector('[data-confirm]');
  if (confirm) confirm.addEventListener('click', onConfirm);
}

function closeDeletePopovers(root) {
  root.querySelectorAll('.delete-popover').forEach((p) => p.remove());
}

let docTipEl = null;
function showDocTip(anchor, project) {
  hideDocTip();
  const docs = project.documents || [];
  const enabled = new Set(project.config?.enabledDocumentIds || docs.map((d) => d.id));
  const tip = document.createElement('div');
  tip.className = 'doc-tip';
  tip.innerHTML = docs.length
    ? docs.map((d) => {
      const n = (d.graph?.nodes || []).length;
      const e = edgeCountOf(d.graph);
      return `<div class="doc-tip-row${enabled.has(d.id) ? '' : ' off'}"><span class="dt-name">${escapeHtml(d.name)}</span><span class="dt-meta">${n}·${e}</span></div>`;
    }).join('')
    : '<div class="doc-tip-row">无文档</div>';
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${r.bottom + 6}px`;
  docTipEl = tip;
}
function hideDocTip() { if (docTipEl) { docTipEl.remove(); docTipEl = null; } }

function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
