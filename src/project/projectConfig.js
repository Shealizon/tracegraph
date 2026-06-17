import { graphToDocument, normalizeProject, uniqueId } from './projectAdapter.js';
import { isProjectPayload, saveProject } from './store.js';
import { extractFixedTexGraph } from '../import/texExtract.js';
import { ICON } from '../ui/icons.js';

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
  const auxFile = confirm('是否选择对应的 .aux 文件以保留论文编号？') ? await pickFile('.aux,text/plain') : null;
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
  const multiDoc = project.documents.length > 1;
  const docMeta = (doc) => `${(doc.graph?.nodes || []).length} 节点 · ${(doc.graph?.edges || []).length} 关系`;

  overlay.innerHTML = `
    <div class="project-dialog">
      <div class="project-dialog-head">
        <h2>项目配置</h2>
        <button class="icon-btn icon-btn--bordered" data-close title="关闭">${ICON.close}</button>
      </div>
      <p class="project-dialog-desc">选择要纳入关系图的文件。展开「高级」可按单条精确开关节点与关系。</p>
      <div class="project-dialog-body">
        <label class="project-field">项目名称<input data-name value="${escapeAttr(project.name)}"></label>

        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">文件</span>
            <span class="cfg-count" data-count-doc></span>
            <div class="cfg-add">
              <button class="btn btn--sm" data-add>${ICON.plus}<span>添加文件</span></button>
            </div>
          </div>
          <div class="cfg-rows" data-docs>${project.documents.length
            ? project.documents.map((doc) => fileRow(doc, enabledDocs.has(doc.id), docMeta(doc))).join('')
            : '<div class="cfg-empty">还没有文件，点「添加文件」导入。</div>'}</div>
        </section>

        <div class="disclosure collapsed cfg-advanced" data-adv>
          <button class="disc-head" type="button"><span class="disc-caret">${ICON.chevronDown}</span><span>高级 · 按单条调整节点与关系</span></button>
          <div class="disc-body">
            <div class="cfg-adv-grid">
              <section class="cfg-col">
                <div class="cfg-col-head"><span>节点</span><span class="cfg-count" data-count-node></span><button class="cfg-selall" data-selall="node" type="button">全选/反选</button></div>
                <div class="cfg-rows cfg-rows--scroll" data-nodes>${nodeRows.map(({ doc, node }) => checkRow('node', node.id, !disabledNodes.has(node.id), `${node.typeLabel || node.type} ${node.number || ''} · ${node.title || node.id}`, multiDoc ? doc.name : '')).join('')}</div>
              </section>
              <section class="cfg-col">
                <div class="cfg-col-head"><span>关系</span><span class="cfg-count" data-count-rel></span><button class="cfg-selall" data-selall="relation" type="button">全选/反选</button></div>
                <div class="cfg-rows cfg-rows--scroll" data-relations>${relationRows.map(({ doc, edge, key }) => checkRow('relation', key, !disabledRelations.has(key), `${edge.fromLabel || edge.from} → ${edge.to}`, multiDoc ? doc.name : '')).join('')}</div>
              </section>
            </div>
          </div>
        </div>
      </div>
      <div class="project-dialog-actions">
        <button class="btn" data-cancel>取消</button>
        <button class="btn btn--primary" data-save>保存配置</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const $ = (sel) => overlay.querySelector(sel);

  // 实时计数
  const updateCounts = () => {
    const count = (type) => {
      const all = [...overlay.querySelectorAll(`input[data-type="${type}"]`)];
      return [all.filter((i) => i.checked).length, all.length];
    };
    const set = (sel, [on, total]) => { const e = $(sel); if (e) e.textContent = total ? `启用 ${on}/${total}` : ''; };
    set('[data-count-doc]', count('doc'));
    set('[data-count-node]', count('node'));
    set('[data-count-rel]', count('relation'));
  };
  updateCounts();
  overlay.addEventListener('change', (ev) => { if (ev.target.matches('input[type="checkbox"]')) updateCounts(); });

  // 折叠「高级」
  $('[data-adv] .disc-head').addEventListener('click', () => $('[data-adv]').classList.toggle('collapsed'));

  // 全选/反选
  overlay.querySelectorAll('[data-selall]').forEach((b) => b.addEventListener('click', () => {
    const type = b.dataset.selall;
    const boxes = [...overlay.querySelectorAll(`input[data-type="${type}"]`)];
    const allOn = boxes.every((i) => i.checked);
    boxes.forEach((i) => { i.checked = !allOn; });
    updateCounts();
  }));

  // 添加文件菜单（JSON / TeX / PDF 即将支持）
  attachAddFileMenu($('[data-add]'), {
    onJson: async () => { await importStructuredJson(db, project); close(); onSaved && onSaved(); },
    onTex: async () => { await importFixedTex(db, project); close(); onSaved && onSaved(); },
  });

  $('[data-close]').addEventListener('click', close);
  $('[data-cancel]').addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  $('[data-save]').addEventListener('click', async () => {
    const docIds = checkedValues(overlay, 'doc');
    const enabledNodeIds = new Set(checkedValues(overlay, 'node'));
    const enabledRelationKeys = new Set(checkedValues(overlay, 'relation'));
    const next = normalizeProject({
      ...project,
      name: $('[data-name]').value.trim() || project.name,
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

// 文件区「+ 添加文件」下拉菜单
function attachAddFileMenu(anchor, { onJson, onTex }) {
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', onDoc, true); } };
  const onDoc = (ev) => { if (menu && !menu.contains(ev.target) && ev.target !== anchor) close(); };
  anchor.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menu) { close(); return; }
    menu = document.createElement('div');
    menu.className = 'side-menu';
    menu.innerHTML = `
      <button class="side-menu-item" data-json>结构化 JSON</button>
      <button class="side-menu-item" data-tex>固定 TeX</button>
      <button class="side-menu-item" data-pdf disabled>PDF<span class="cfg-soon">即将支持</span></button>`;
    menu.querySelector('[data-json]').addEventListener('click', () => { close(); onJson(); });
    menu.querySelector('[data-tex]').addEventListener('click', () => { close(); onTex(); });
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, r.right - 168)}px`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  });
}

export function openCreateProjectDialog({ db, demoProject, onSaved }) {
  const overlay = document.createElement('div');
  overlay.className = 'project-dialog-backdrop';
  overlay.innerHTML = `
    <div class="project-dialog small">
      <div class="project-dialog-head"><h2>创建项目</h2><button class="icon-btn icon-btn--bordered" data-close title="关闭">${ICON.close}</button></div>
      <label class="project-field">项目名称<input data-name value="新项目"></label>
      <label class="project-check"><input type="checkbox" data-demo checked> 包含当前 Hardy 样例文档</label>
      <label class="project-check"><input type="checkbox" data-docs checked> 默认启用所有导入文件</label>
      <label class="project-check"><input type="checkbox" data-bib checked> 默认显示文献节点</label>
      <label class="project-check"><input type="checkbox" data-cross checked> 默认显示跨文档关系</label>
      <div class="project-dialog-actions"><button class="btn btn--primary" data-save>创建</button></div>
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

// 文件行：启用开关 + 文件名 + 节点/关系计数
function fileRow(doc, checked, meta) {
  return `<label class="project-file"><input type="checkbox" data-type="doc" value="${escapeAttr(doc.id)}"${checked ? ' checked' : ''}><span class="pf-name">${escapeHtml(doc.name)}</span><span class="pf-meta">${escapeHtml(meta)}</span></label>`;
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
