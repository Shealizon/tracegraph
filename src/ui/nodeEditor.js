import { ICON } from './icons.js';
import { confirmDialog, toast } from './feedback.js';
import {
  availableReferenceTargets, createProjectNode, deleteProjectNode,
  nodeDraftFromProject, updateProjectNode, validateNodeDraft,
} from '../project/nodeOperations.js';

let referenceSequence = 1;

export function openNodeEditor(ctx, nodeId = '') {
  if (!ctx.nodeEditingEnabled) return null;
  ctx._nodeEditorClose?.(true);
  const runtimeNode = nodeId ? ctx.model.nodeById.get(nodeId) : null;
  if (nodeId && !runtimeNode) { toast('找不到要编辑的节点', { type: 'error' }); return null; }
  if (!runtimeNode && !(ctx.project?.documents || []).length) {
    toast('请先在项目配置中导入一个文件', { type: 'error' });
    return null;
  }

  const creating = !runtimeNode;
  const initial = runtimeNode ? nodeDraftFromProject(ctx.project, runtimeNode) : newNodeDraft(ctx);
  if (!initial) { toast('找不到节点的原始数据', { type: 'error' }); return null; }
  const referenceTargets = availableReferenceTargets(ctx.project);
  const relationTypes = collectRelationTypes(ctx, initial);
  const overlay = document.createElement('div');
  overlay.className = 'node-editor-backdrop';
  overlay.innerHTML = `
    <section class="node-editor" role="dialog" aria-modal="true" aria-labelledby="node-editor-title">
      <header class="node-editor-head">
        <div><h2 id="node-editor-title">${creating ? '新增节点' : '编辑节点'}</h2><p>${creating ? '创建后会重新构建关系图' : escapeHtml(runtimeNode.documentName || '')}</p></div>
        <span class="node-editor-status" data-status>尚未修改</span>
        <button class="icon-btn icon-btn--bordered" type="button" data-close title="关闭">${ICON.close}</button>
      </header>
      <div class="node-editor-body">
        <section class="node-editor-section">
          <div class="node-editor-section-title">基本信息</div>
          <div class="node-editor-grid">
            <label>所属文件<select data-document${creating ? '' : ' disabled'}>${documentOptions(ctx.project, initial.documentId)}</select></label>
            <label>节点类型<select data-type>${typeOptions(ctx, initial.type)}</select></label>
            <label>节点 ID<input data-id value="${escapeAttr(initial.id)}"${creating ? '' : ' readonly'} spellcheck="false"></label>
            <label>显示编号<input data-number value="${escapeAttr(initial.number)}" placeholder="可选"></label>
            <label class="node-editor-wide">标题<input data-title value="${escapeAttr(initial.title)}" placeholder="节点标题"></label>
          </div>
          ${creating ? '<p class="node-editor-help">节点 ID 创建后不可在界面中修改，请使用稳定且不含空格的标识。</p>' : '<p class="node-editor-help">为保证引用关系稳定，已有节点的 ID 不可修改。</p>'}
        </section>
        <section class="node-editor-section">
          <div class="node-editor-section-head"><div class="node-editor-section-title">内容</div><button class="btn btn--sm" type="button" data-preview>${ICON.eye}<span>预览</span></button></div>
          <label class="node-editor-text-field"><span>正文</span><textarea data-statement placeholder="节点正文，支持当前文档的 Markdown 或 LaTeX 格式">${escapeHtml(initial.statementBody)}</textarea></label>
          <label class="node-editor-text-field"><span>证明 / 详情</span><textarea data-proof placeholder="可选">${escapeHtml(initial.proofBody)}</textarea></label>
          <div class="node-editor-preview" data-preview-panel hidden></div>
        </section>
        <section class="node-editor-section">
          <div class="node-editor-section-head"><div><div class="node-editor-section-title">引用关系</div><p class="node-editor-help">填写本节点引用的锚点 ID；保存后关系图会重新计算。</p></div><button class="btn btn--sm" type="button" data-add-ref>${ICON.plus}<span>添加引用</span></button></div>
          <div class="node-editor-refs" data-refs></div>
          <datalist id="node-editor-targets-${referenceSequence}">${referenceTargets.map((target) => `<option value="${escapeAttr(target)}"></option>`).join('')}</datalist>
        </section>
      </div>
      <footer class="node-editor-actions">
        ${creating ? '' : '<button class="btn btn--danger" type="button" data-delete>删除节点</button>'}
        <span></span>
        <button class="btn" type="button" data-cancel>取消</button>
        <button class="btn btn--primary" type="button" data-save>${creating ? '创建节点' : '保存修改'}</button>
      </footer>
    </section>`;
  const datalistId = `node-editor-targets-${referenceSequence++}`;
  const datalist = overlay.querySelector('datalist');
  if (datalist) datalist.id = datalistId;
  document.body.appendChild(overlay);

  const refsEl = overlay.querySelector('[data-refs]');
  for (const ref of initial.refs || []) refsEl.appendChild(referenceRow(ref, relationTypes, datalistId));
  if (!initial.refs?.length) renderEmptyRefs(refsEl);

  const readDraft = () => ({
    documentId: overlay.querySelector('[data-document]').value,
    id: overlay.querySelector('[data-id]').value.trim(),
    type: overlay.querySelector('[data-type]').value,
    number: overlay.querySelector('[data-number]').value.trim(),
    title: overlay.querySelector('[data-title]').value.trim(),
    statementBody: overlay.querySelector('[data-statement]').value,
    proofBody: overlay.querySelector('[data-proof]').value,
    refs: [...refsEl.querySelectorAll('.node-editor-ref')].map((row) => ({
      key: row.dataset.key,
      target: row.querySelector('[data-ref-target]').value.trim(),
      relation: row.querySelector('[data-ref-relation]').value,
      where: row.querySelector('[data-ref-where]').value,
    })),
  });
  const initialSnapshot = JSON.stringify(readDraft());
  const isDirty = () => JSON.stringify(readDraft()) !== initialSnapshot;
  const setStatus = (text, tone = '') => {
    const status = overlay.querySelector('[data-status]');
    status.textContent = text;
    status.dataset.tone = tone;
  };
  const onInput = () => setStatus(isDirty() ? '有未保存修改' : '尚未修改', isDirty() ? 'dirty' : '');
  overlay.addEventListener('input', onInput);
  overlay.addEventListener('change', onInput);

  let closing = false;
  const close = async (force = false) => {
    if (closing) return;
    if (!force && isDirty()) {
      const discard = await confirmDialog({ title: '放弃节点修改', message: '当前修改尚未保存，确定放弃吗？', okText: '放弃修改', danger: true });
      if (!discard) return;
    }
    closing = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (ctx._nodeEditor === overlay) { ctx._nodeEditor = null; ctx._nodeEditorClose = null; }
  };
  const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ctx._nodeEditor = overlay;
  ctx._nodeEditorClose = close;

  overlay.querySelector('[data-close]').addEventListener('click', () => close());
  overlay.querySelector('[data-cancel]').addEventListener('click', () => close());
  overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-add-ref]').addEventListener('click', () => {
    refsEl.querySelector('.node-editor-empty')?.remove();
    const row = referenceRow({ key: `ref-new-${Date.now()}-${referenceSequence++}`, target: '', relation: 'ref', where: 'statement' }, relationTypes, datalistId);
    refsEl.appendChild(row);
    row.querySelector('input')?.focus();
    onInput();
  });
  refsEl.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-ref]');
    if (!remove) return;
    remove.closest('.node-editor-ref')?.remove();
    renderEmptyRefs(refsEl);
    onInput();
  });
  overlay.querySelector('[data-preview]').addEventListener('click', (event) => {
    const panel = overlay.querySelector('[data-preview-panel]');
    const visible = panel.hidden;
    panel.hidden = !visible;
    event.currentTarget.classList.toggle('is-active', visible);
    event.currentTarget.querySelector('span').textContent = visible ? '关闭预览' : '预览';
    if (visible) renderPreview(ctx, panel, readDraft());
  });
  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const button = overlay.querySelector('[data-save]');
    const draft = readDraft();
    const errors = validateNodeDraft(ctx.project, draft, { creating });
    const knownTargets = new Set(availableReferenceTargets(ctx.project));
    const unresolved = draft.refs.map((ref) => ref.target).filter((target) => target && !knownTargets.has(target) && target !== draft.id);
    if (unresolved.length) errors.push(`找不到引用目标：${[...new Set(unresolved)].slice(0, 3).join('、')}`);
    if (errors.length) { setStatus(errors[0], 'error'); toast(errors[0], { type: 'error' }); return; }
    if (!creating && !isDirty()) { toast('节点没有变化'); return; }
    button.disabled = true;
    setStatus(creating ? '正在创建…' : '正在保存…');
    try {
      const next = creating
        ? createProjectNode(ctx.project, draft)
        : updateProjectNode(ctx.project, initial.documentId, initial.id, draft);
      await ctx.persistNodeProject(next, { message: creating ? '节点已创建' : '节点已更新', nodeId: draft.id });
      await close(true);
    } catch (error) {
      button.disabled = false;
      setStatus(error?.message || '保存失败', 'error');
      toast(`保存失败：${error?.message || error}`, { type: 'error' });
    }
  });
  overlay.querySelector('[data-delete]')?.addEventListener('click', () => requestDeleteNode(ctx, runtimeNode.id, { closeEditor: close }));
  requestAnimationFrame(() => overlay.querySelector(creating ? '[data-id]' : '[data-title]')?.focus());
  return overlay;
}

export async function requestDeleteNode(ctx, nodeId, { closeEditor = null } = {}) {
  if (!ctx.nodeEditingEnabled) return false;
  const node = ctx.model.nodeById.get(nodeId);
  if (!node) return false;
  const inbound = ctx.model.usedBy.get(nodeId)?.size || 0;
  const tagCount = (ctx.graph?.getTags?.() || []).reduce((count, tag) => count + (tag.members || []).filter((member) => (typeof member === 'string' ? member : member?.node) === nodeId).length, 0);
  const impacts = [inbound ? `${inbound} 个节点正在引用它` : '', tagCount ? `${tagCount} 个标签成员会被移除` : ''].filter(Boolean);
  const ok = await confirmDialog({
    title: '删除节点',
    message: `确定永久删除「${node.title || node.id}」吗？${impacts.length ? `\n${impacts.join('；')}。` : ''}\n节点正文无法自动恢复。`,
    okText: '永久删除',
    danger: true,
  });
  if (!ok) return false;
  try {
    const next = deleteProjectNode(ctx.project, node.documentId, node.sourceNodeId || node.id, node.id);
    await ctx.persistNodeProject(next, { message: '节点已删除' });
    await closeEditor?.(true);
    return true;
  } catch (error) {
    toast(`删除失败：${error?.message || error}`, { type: 'error' });
    return false;
  }
}

function newNodeDraft(ctx) {
  const enabled = new Set(ctx.project.config?.enabledDocumentIds || []);
  const document = ctx.project.documents.find((item) => enabled.has(item.id)) || ctx.project.documents[0];
  const type = ctx.model.meta?.profileResolved?.types?.find((item) => !item.leaf)?.id
    || ctx.model.meta?.profileResolved?.types?.[0]?.id || 'node';
  return {
    documentId: document?.id || '', id: `node-${Date.now().toString(36)}`, type,
    number: '', title: '', statementBody: '', proofBody: '', refs: [],
  };
}

function referenceRow(ref, relationTypes, datalistId) {
  const row = document.createElement('div');
  row.className = 'node-editor-ref';
  row.dataset.key = ref.key || `ref-new-${referenceSequence++}`;
  row.innerHTML = `
    <input data-ref-target list="${escapeAttr(datalistId)}" value="${escapeAttr(ref.target || '')}" placeholder="目标锚点 ID" aria-label="引用目标">
    <select data-ref-relation aria-label="引用类型">${relationTypes.map((type) => `<option value="${escapeAttr(type)}"${type === (ref.relation || 'ref') ? ' selected' : ''}>${escapeHtml(type)}</option>`).join('')}</select>
    <select data-ref-where aria-label="引用位置"><option value="statement"${ref.where === 'proof' ? '' : ' selected'}>正文</option><option value="proof"${ref.where === 'proof' ? ' selected' : ''}>详情</option></select>
    <button class="icon-btn icon-btn--danger" type="button" data-remove-ref title="删除引用">${ICON.trash}</button>`;
  return row;
}

function renderEmptyRefs(root) {
  if (root.querySelector('.node-editor-ref, .node-editor-empty')) return;
  const empty = document.createElement('div'); empty.className = 'node-editor-empty'; empty.textContent = '暂无引用关系'; root.appendChild(empty);
}

function renderPreview(ctx, panel, draft) {
  const statement = draft.statementBody ? ctx.render(draft.statementBody) : '<p class="node-editor-muted">无正文</p>';
  const proof = draft.proofBody ? ctx.render(draft.proofBody) : '';
  panel.innerHTML = `<h3>${escapeHtml(draft.title || draft.id || '未命名节点')}</h3><div class="statement">${statement}</div>${proof ? `<details open><summary>证明 / 详情</summary><div class="proof-wrap">${proof}</div></details>` : ''}`;
}

function collectRelationTypes(ctx, draft) {
  const values = new Set(['ref', 'eqref', 'cite']);
  for (const relation of draft.refs || []) values.add(relation.relation || 'ref');
  for (const document of ctx.project?.documents || []) for (const relation of document.graph?.relations || []) values.add(relation.id);
  return [...values].filter(Boolean);
}

function documentOptions(project, selected) {
  return (project?.documents || []).map((document) => `<option value="${escapeAttr(document.id)}"${document.id === selected ? ' selected' : ''}>${escapeHtml(document.name || document.id)}</option>`).join('');
}

function typeOptions(ctx, selected) {
  const types = ctx.model.meta?.profileResolved?.types || [];
  const values = types.length ? [...types] : [{ id: selected || 'node', label: selected || '节点' }];
  if (selected && !values.some((type) => type.id === selected)) values.push({ id: selected, label: selected });
  return values.map((type) => `<option value="${escapeAttr(type.id)}"${type.id === selected ? ' selected' : ''}>${escapeHtml(type.label || type.id)}</option>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
