import rawDemoGraph from '../data/paper-graph.json';
import { createDemoProject } from '../project/projectAdapter.js';
import { deleteProject, listProjects, setCurrentProjectId } from '../project/store.js';
import { downloadProject, importFixedTex, importStructuredJson, openCreateProjectDialog, openProjectConfigDialog, projectMainUrl, showTodoImport } from '../project/projectConfig.js';

export function renderLeadingPage({ db, projects, currentProjectId }) {
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
      <header class="leading-hero">
        <div>
          <p class="leading-kicker">Paper Graph Projects</p>
          <h1>项目级论文关系图管理</h1>
          <p>一个项目可以包含多篇论文或结构化关系文件，并在同一个图谱中展示节点与引用关系。所有内容只保存在当前浏览器本地。</p>
        </div>
        <div class="leading-actions">
          <button class="side-btn primary-btn" data-create>创建项目</button>
          <button class="side-btn" data-import-json>导入结构化 JSON</button>
          <button class="side-btn" data-import-tex>导入固定 TeX</button>
          <button class="side-btn" data-import-pdf>导入 PDF / 非固定格式 TODO</button>
        </div>
      </header>
      <section class="leading-panel">
        <div class="leading-panel-head"><h2>项目</h2><span>${projects.length} 个本地项目</span></div>
        <div class="project-cards">
          ${projects.map((project) => projectCard(project, project.id === current?.id)).join('')}
        </div>
      </section>
    </div>`;

  const refresh = async (selectId = null) => {
    const nextProjects = await listProjects(db);
    const nextId = selectId || currentProjectId || nextProjects[0]?.id;
    if (nextId) setCurrentProjectId(nextId);
    renderLeadingPage({ db, projects: nextProjects, currentProjectId: nextId });
  };
  const demoProject = createDemoProject(rawDemoGraph);
  root.querySelector('[data-create]').addEventListener('click', () => openCreateProjectDialog({ db, demoProject, onSaved: (p) => refresh(p.id) }));
  root.querySelector('[data-import-json]').addEventListener('click', async () => { const p = await importStructuredJson(db); if (p) refresh(p.id); });
  root.querySelector('[data-import-tex]').addEventListener('click', async () => { const p = await importFixedTex(db); if (p) refresh(p.id); });
  root.querySelector('[data-import-pdf]').addEventListener('click', showTodoImport);

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
    if (projects.length <= 1) { alert('至少保留一个项目。'); return; }
    const project = projects.find((p) => p.id === btn.dataset.delete);
    if (!project || !confirm(`删除项目「${project.name}」？`)) return;
    await deleteProject(db, project.id);
    refresh();
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
      <p>${docs.length} 个文件 · 启用 ${enabledCount} 个 · 更新于 ${formatDate(project.updatedAt)}</p>
      <div class="project-card-docs">${docs.slice(0, 4).map((d) => `<span>${escapeHtml(d.name)}</span>`).join('')}${docs.length > 4 ? '<span>...</span>' : ''}</div>
      <div class="project-card-actions">
        <button class="side-btn primary-btn" data-open="${escapeAttr(project.id)}">打开关系图</button>
        <button class="side-btn" data-config="${escapeAttr(project.id)}">配置</button>
        <button class="side-btn" data-export="${escapeAttr(project.id)}">导出</button>
        <button class="side-btn danger-btn" data-delete="${escapeAttr(project.id)}">删除</button>
      </div>
    </article>`;
}

function formatDate(value) {
  if (!value) return '未知';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
