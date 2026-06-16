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
        <div>
          <h1>Paper Graph</h1>
          <span>${projects.length} 个本地项目</span>
        </div>
        <div data-leading-theme></div>
      </header>
      <section class="leading-panel">
        <div class="project-cards">
          ${projects.map((project) => projectCard(project, project.id === current?.id)).join('')}
          <article class="project-card project-card-create" data-create>
            <div class="create-plus">${ICON.plus}</div>
            <div>新建项目</div>
          </article>
        </div>
      </section>
    </div>`;
  root.querySelector('[data-leading-theme]').appendChild(buildLeadingThemeSwitch());

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

  root.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => {
    setCurrentProjectId(btn.dataset.open);
    location.href = projectMainUrl(btn.dataset.open);
  }));
  root.querySelectorAll('[data-config]').forEach((btn) => btn.addEventListener('click', () => {
    const project = projects.find((p) => p.id === btn.dataset.config);
    if (project) openProjectConfigDialog({ db, project, onSaved: (p) => refresh(p?.id || project.id) });
  }));
  root.querySelectorAll('[data-export]').forEach((btn) => btn.addEventListener('click', () => {
    const project = projects.find((p) => p.id === btn.dataset.export);
    if (project) downloadProject(project);
  }));
  root.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
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
  const enabledCount = project.config?.enabledDocumentIds?.length || docs.length;
  return `
    <article class="project-card${active ? ' active' : ''}">
      <div class="project-card-top">
        <h3>${escapeHtml(project.name)}</h3>
        ${active ? '<span>当前</span>' : ''}
      </div>
      <p>${docs.length} 个文件 · 启用 ${enabledCount} 个</p>
      <div class="project-card-docs">${docs.slice(0, 4).map((d) => `<span>${escapeHtml(d.name)}</span>`).join('')}${docs.length > 4 ? '<span>...</span>' : ''}</div>
      <div class="project-card-actions">
        <button class="round-icon-btn" title="打开" data-open="${escapeAttr(project.id)}">${ICON.play}</button>
        <button class="round-icon-btn" title="配置" data-config="${escapeAttr(project.id)}">${ICON.settings}</button>
        <button class="round-icon-btn" title="导出" data-export="${escapeAttr(project.id)}">${ICON.download}</button>
        <button class="round-icon-btn danger" title="删除" data-delete="${escapeAttr(project.id)}">${ICON.trash}</button>
      </div>
    </article>`;
}

function buildLeadingThemeSwitch() {
  const wrap = document.createElement('div');
  wrap.className = 'theme-switch';
  const mode = localStorage.getItem('hg-theme-mode') || localStorage.getItem('hg-theme') || 'system';
  const sync = () => {
    const nextMode = localStorage.getItem('hg-theme-mode') || 'system';
    const idx = Math.max(0, THEME_MODES.findIndex((m) => m.mode === nextMode));
    wrap.style.setProperty('--theme-idx', String(idx));
    wrap.querySelectorAll('[data-theme-mode]').forEach((b) => b.classList.toggle('active', b.dataset.themeMode === nextMode));
  };
  for (const item of THEME_MODES) {
    const b = document.createElement('button');
    b.className = 'theme-seg';
    b.type = 'button';
    b.title = item.title;
    b.dataset.themeMode = item.mode;
    b.innerHTML = ICON[item.icon] || '';
    b.addEventListener('click', () => {
      localStorage.setItem('hg-theme-mode', item.mode);
      applyStoredTheme();
      sync();
    });
    wrap.appendChild(b);
  }
  const thumb = document.createElement('span');
  thumb.className = 'theme-thumb';
  wrap.appendChild(thumb);
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
  pop.querySelector('[data-cancel]').addEventListener('click', () => pop.remove());
  const confirm = pop.querySelector('[data-confirm]');
  if (confirm) confirm.addEventListener('click', onConfirm);
}

function closeDeletePopovers(root) {
  root.querySelectorAll('.delete-popover').forEach((p) => p.remove());
}

function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
