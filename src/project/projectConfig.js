import { graphToDocument, normalizeProject, uniqueId } from './projectAdapter.js';
import { isProjectPayload, saveProject } from './store.js';
import { extractFixedTexGraph } from '../import/texExtract.js';
import { extractGenericTexGraph } from '../import/texGeneric.js';
import { ICON } from '../ui/icons.js';
import { toast, confirmDialog } from '../ui/feedback.js';

export function projectMainUrl(projectId) {
  return `${location.pathname}?screen=main&project=${encodeURIComponent(projectId)}`;
}

export function goLeading() {
  location.href = location.pathname;
}

export function downloadProject(project) {
  downloadJson(project, `${safeName(project.name || project.id)}.paper-graph-project.json`);
}

export async function importStructuredJson(db, currentProject = null, file = null) {
  file = file || await pickFile('.json,application/json');
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

export async function importFixedTex(db, currentProject = null, texFile = null) {
  texFile = texFile || await pickFile('.tex,text/x-tex,text/plain');
  if (!texFile) return null;
  const useAux = await confirmDialog({ title: '保留论文编号', message: '是否同时选择对应的 .aux 文件以沿用论文中的编号？取消则自动编号。', okText: '选择 .aux', cancelText: '自动编号' });
  const auxFile = useAux ? await pickFile('.aux,text/plain') : null;
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

// 通用 TeX（自动识别）：无需固定格式，自动发现定理类环境，全部本地解析
export async function importGenericTex(db, currentProject = null, texFile = null) {
  texFile = texFile || await pickFile('.tex,.txt,text/x-tex,text/plain');
  if (!texFile) return null;
  // 通用 TeX 自动识别本就自动编号，不再询问 .aux
  const graph = extractGenericTexGraph(await texFile.text(), '', { source: texFile.name, title: texFile.name.replace(/\.(tex|txt)$/i, '') });
  const doc = graphToDocument(graph, texFile.name, 'generic-tex');
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
  toast('PDF 本地解析开发中：将在浏览器内提取文字层并做结构识别。当前可用 JSON / TeX 导入。');
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
  // 项目名：仅当尚未命名（name 为空）时 input 留空、用 placeholder 提示，保存时把 placeholder 落实为名称；
  // 一旦有了名称（含保存后落实的占位名）则正常回显，不再清空。有文件则 placeholder 用第一个文件名。
  const named = typeof project.name === 'string' && project.name.trim() !== '';
  const phName = project.documents.length ? project.documents[0].name : '新项目';

  overlay.innerHTML = `
    <div class="project-dialog">
      <div class="project-dialog-head">
        <h2>项目配置</h2>
        <button class="icon-btn icon-btn--bordered" data-close title="关闭">${ICON.close}</button>
      </div>
      <p class="project-dialog-desc">选择要纳入关系图的文件。展开「高级」可按单条精确开关节点与关系。</p>
      <div class="project-dialog-body">
        <label class="project-field">项目名称<input data-name value="${named ? escapeAttr(project.name) : ''}" placeholder="${escapeAttr(phName)}"></label>

        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">文件</span>
            <span class="cfg-count" data-count-doc></span>
            <div class="cfg-add">
              <button class="btn btn--sm" data-add title="支持 .json / .tex / .txt，按后缀自动选择导入方式">${ICON.plus}<span>添加文件</span></button>
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

  // 把若干文件按后缀导入当前项目；保留已填名称，导入后重开弹窗（更新文件列表与占位名）
  const importFilesHere = async (fileList) => {
    const valid = [...fileList].filter((f) => /\.(json|tex|txt)$/i.test(f.name));
    if (!valid.length) { toast('仅支持 .json / .tex / .txt'); return; }
    const typed = $('[data-name]').value.trim();
    let proj = typed ? { ...project, name: typed } : project;
    for (const f of valid) {
      try {
        if (/\.json$/i.test(f.name)) proj = await importStructuredJson(db, proj, f);
        else proj = await importGenericTex(db, proj, f);
      } catch (e) { toast(`「${f.name}」导入失败：` + (e?.message || e), { type: 'error' }); }
    }
    close();
    openProjectConfigDialog({ db, project: proj, onSaved });
  };
  // 添加文件：单按钮直接选文件（可多选），按后缀自动选导入方式
  $('[data-add]').addEventListener('click', async () => {
    const file = await pickFile('.json,.tex,.txt,application/json,text/plain');
    if (file) importFilesHere([file]);
  });
  // 支持把文件直接拖拽进配置弹窗追加导入
  overlay.addEventListener('dragover', (ev) => { ev.preventDefault(); overlay.classList.add('drag-over'); });
  overlay.addEventListener('dragleave', (ev) => { if (ev.target === overlay) overlay.classList.remove('drag-over'); });
  overlay.addEventListener('drop', (ev) => {
    ev.preventDefault();
    overlay.classList.remove('drag-over');
    if (ev.dataTransfer?.files?.length) importFilesHere(ev.dataTransfer.files);
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
      name: $('[data-name]').value.trim() || phName,
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
