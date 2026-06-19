import { normalizeProject, uniqueId } from '../project/projectAdapter.js';
import { deleteProject, listProjects, saveProject, setCurrentProjectId } from '../project/store.js';
import { downloadProject, openProjectConfigDialog, projectMainUrl } from '../project/projectConfig.js';
import { ICON } from '../ui/icons.js';

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
        <div data-leading-theme></div>
      </header>
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
  root.querySelector('[data-create]').addEventListener('click', async () => {
    const now = new Date().toISOString();
    const project = normalizeProject({
      id: uniqueId('project'),
      name: '新项目',
      createdAt: now,
      updatedAt: now,
      config: { enabledDocumentIds: [], disabledNodeIds: [], disabledRelationKeys: [], viewState: {} },
      documents: [],
    });
    const saved = await saveProject(db, project);
    setCurrentProjectId(saved.id);
    openProjectConfigDialog({ db, project: saved, onSaved: (p) => refresh(p?.id || saved.id) });
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

function projectCard(project, active) {
  const docs = project.documents || [];
  const enabled = new Set(project.config?.enabledDocumentIds || docs.map((d) => d.id));
  let nodes = 0, rels = 0;
  for (const d of docs) if (enabled.has(d.id)) { nodes += (d.graph?.nodes || []).length; rels += (d.graph?.edges || []).length; }
  const updated = formatDate(project.updatedAt);
  return `
    <article class="project-card${active ? ' active' : ''}" data-card="${escapeAttr(project.id)}" role="button" tabindex="0" title="打开项目">
      <div class="project-card-top">
        <h3>${escapeHtml(project.name)}</h3>
      </div>
      <p class="project-card-meta">${nodes} 节点 · ${rels} 关系 · ${docs.length} 文件</p>
      <div class="project-card-foot">
        <span class="pc-updated">${updated ? `更新于 ${updated}` : ''}</span>
        <div class="project-card-actions">
          ${docs.length ? `<button class="icon-btn" title="文档信息" data-docinfo="${escapeAttr(project.id)}">${ICON.info}</button>` : ''}
          <button class="icon-btn" title="打开" data-open="${escapeAttr(project.id)}">${ICON.play}</button>
          <button class="icon-btn" title="配置" data-config="${escapeAttr(project.id)}">${ICON.settings}</button>
          <button class="icon-btn" title="导出" data-export="${escapeAttr(project.id)}">${ICON.download}</button>
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
      const e = (d.graph?.edges || []).length;
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
