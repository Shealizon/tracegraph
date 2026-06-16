import { graphToDocument, normalizeProject, uniqueId } from './projectAdapter.js';
import { isProjectPayload, saveProject } from './store.js';
import { extractFixedTexGraph } from '../import/texExtract.js';

export function projectMainUrl(projectId) {
  return `${location.pathname}?screen=main&project=${encodeURIComponent(projectId)}`;
}

export function goLeading() {
  location.href = location.pathname;
}

export function downloadProject(project) {
  downloadJson(project, `${safeName(project.name || project.id)}.paper-graph-project.json`);
}

export async function importStructuredJson(db, currentProject = null) {
  const file = await pickFile('.json,application/json');
  if (!file) return null;
  const payload = JSON.parse(await file.text());
  if (isProjectPayload(payload)) {
    const project = normalizeProject({ ...payload, id: payload.id || uniqueId('project') });
    return saveProject(db, project);
  }
  const doc = graphToDocument(payload, file.name, 'structured-json');
  if (currentProject) {
    const project = normalizeProject({
      ...currentProject,
      documents: [...currentProject.documents, doc],
      config: {
        ...currentProject.config,
        enabledDocumentIds: [...new Set([...(currentProject.config.enabledDocumentIds || []), doc.id])],
      },
    });
    return saveProject(db, project);
  }
  const now = new Date().toISOString();
  return saveProject(db, {
    id: uniqueId('project'),
    name: doc.name,
    createdAt: now,
    updatedAt: now,
    config: { enabledDocumentIds: [doc.id], disabledNodeIds: [], disabledRelationKeys: [], viewState: {} },
    documents: [doc],
  });
}

export async function importFixedTex(db, currentProject = null) {
  const texFile = await pickFile('.tex,text/x-tex,text/plain');
  if (!texFile) return null;
  const auxFile = await pickFile('.aux,text/plain', '选择对应 .aux 文件（可取消）');
  const graph = extractFixedTexGraph(await texFile.text(), auxFile ? await auxFile.text() : '', { source: texFile.name, title: texFile.name.replace(/\.tex$/i, '') });
  const doc = graphToDocument(graph, texFile.name, 'fixed-tex');
  if (currentProject) {
    const project = normalizeProject({
      ...currentProject,
      documents: [...currentProject.documents, doc],
      config: {
        ...currentProject.config,
        enabledDocumentIds: [...new Set([...(currentProject.config.enabledDocumentIds || []), doc.id])],
      },
    });
    return saveProject(db, project);
  }
  const now = new Date().toISOString();
  return saveProject(db, {
    id: uniqueId('project'),
    name: doc.name,
    createdAt: now,
    updatedAt: now,
    config: { enabledDocumentIds: [doc.id], disabledNodeIds: [], disabledRelationKeys: [], viewState: {} },
    documents: [doc],
  });
}

export function showTodoImport() {
  alert('PDF / 非固定格式导入暂未实现。后续需要 OCR、结构识别和 LLM 接入。');
}

export function openProjectConfigDialog({ db, project, onSaved }) {
  const overlay = document.createElement('div');
  overlay.className = 'project-dialog-backdrop';
  const enabledDocs = new Set(project.config.enabledDocumentIds || project.documents.map((d) => d.id));
  const disabledNodes = new Set(project.config.disabledNodeIds || []);
  const disabledRelations = new Set(project.config.disabledRelationKeys || []);
  const nodeRows = project.documents.flatMap((doc) => (doc.graph?.nodes || []).map((n) => ({ doc, node: n })));
  const relationRows = project.documents.flatMap((doc) => (doc.graph?.edges || []).map((e) => ({ doc, edge: e, key: `${e.from}|${e.fromLabel}|${e.to}` })));
  overlay.innerHTML = `
    <div class="project-dialog">
      <div class="project-dialog-head">
        <h2>项目配置</h2>
        <button class="m-btn" data-close title="关闭">✕</button>
      </div>
      <label class="project-field">项目名称<input data-name value="${escapeAttr(project.name)}"></label>
      <div class="project-config-grid">
        <section><h3>导入文件</h3><div class="project-check-list" data-docs>${project.documents.map((doc) => checkRow('doc', doc.id, enabledDocs.has(doc.id), doc.name)).join('')}</div></section>
        <section><h3>节点</h3><div class="project-check-list" data-nodes>${nodeRows.map(({ doc, node }) => checkRow('node', node.id, !disabledNodes.has(node.id), `${node.typeLabel || node.type} ${node.number || ''} · ${node.title || node.id}`, doc.name)).join('')}</div></section>
        <section><h3>关系</h3><div class="project-check-list" data-relations>${relationRows.map(({ doc, edge, key }) => checkRow('relation', key, !disabledRelations.has(key), `${edge.fromLabel || edge.from} → ${edge.to}`, doc.name)).join('')}</div></section>
      </div>
      <div class="project-dialog-actions">
        <button class="side-btn" data-import-json>导入结构化 JSON</button>
        <button class="side-btn" data-import-tex>导入固定 TeX</button>
        <button class="side-btn" data-import-pdf>导入 PDF / 非固定格式 TODO</button>
        <button class="side-btn primary-btn" data-save>保存配置</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.querySelector('[data-import-json]').addEventListener('click', async () => { await importStructuredJson(db, project); close(); onSaved && onSaved(); });
  overlay.querySelector('[data-import-tex]').addEventListener('click', async () => { await importFixedTex(db, project); close(); onSaved && onSaved(); });
  overlay.querySelector('[data-import-pdf]').addEventListener('click', showTodoImport);
  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const docIds = checkedValues(overlay, 'doc');
    const enabledNodeIds = new Set(checkedValues(overlay, 'node'));
    const enabledRelationKeys = new Set(checkedValues(overlay, 'relation'));
    const next = normalizeProject({
      ...project,
      name: overlay.querySelector('[data-name]').value.trim() || project.name,
      config: {
        ...project.config,
        enabledDocumentIds: docIds,
        disabledNodeIds: nodeRows.map(({ node }) => node.id).filter((id) => !enabledNodeIds.has(id)),
        disabledRelationKeys: relationRows.map((r) => r.key).filter((key) => !enabledRelationKeys.has(key)),
      },
    });
    await saveProject(db, next);
    close();
    onSaved && onSaved(next);
  });
}

export function openCreateProjectDialog({ db, demoProject, onSaved }) {
  const overlay = document.createElement('div');
  overlay.className = 'project-dialog-backdrop';
  overlay.innerHTML = `
    <div class="project-dialog small">
      <div class="project-dialog-head"><h2>创建项目</h2><button class="m-btn" data-close title="关闭">✕</button></div>
      <label class="project-field">项目名称<input data-name value="新项目"></label>
      <label class="project-check"><input type="checkbox" data-demo checked> 包含当前 Hardy 样例文档</label>
      <label class="project-check"><input type="checkbox" data-docs checked> 默认启用所有导入文件</label>
      <label class="project-check"><input type="checkbox" data-bib checked> 默认显示文献节点</label>
      <label class="project-check"><input type="checkbox" data-cross checked> 默认显示跨文档关系</label>
      <div class="project-dialog-actions"><button class="side-btn primary-btn" data-save>创建</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const includeDemo = overlay.querySelector('[data-demo]').checked;
    const docs = includeDemo ? demoProject.documents.map((d) => ({ ...d, id: uniqueId('doc') })) : [];
    const now = new Date().toISOString();
    const project = normalizeProject({
      id: uniqueId('project'),
      name: overlay.querySelector('[data-name]').value.trim() || '新项目',
      createdAt: now,
      updatedAt: now,
      config: { enabledDocumentIds: docs.map((d) => d.id), disabledNodeIds: [], disabledRelationKeys: [], viewState: {} },
      documents: docs,
    });
    await saveProject(db, project);
    close();
    onSaved && onSaved(project);
  });
}

function pickFile(accept, _label = '') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

function checkedValues(root, type) {
  return [...root.querySelectorAll(`input[data-type="${type}"]`)].filter((i) => i.checked).map((i) => i.value);
}

function checkRow(type, value, checked, label, sub = '') {
  return `<label class="project-check"><input type="checkbox" data-type="${type}" value="${escapeAttr(value)}"${checked ? ' checked' : ''}><span>${escapeHtml(label)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</label>`;
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function safeName(name) { return String(name).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'project'; }
function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
