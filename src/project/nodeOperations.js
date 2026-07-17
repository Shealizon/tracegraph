import { isGenericSchema } from '../data/adapter.js';
import { memberNode } from '../data/schema.js';

export function findProjectNode(project, documentId, sourceNodeId) {
  const document = (project?.documents || []).find((item) => item.id === documentId);
  if (!document) return null;
  const index = (document.graph?.nodes || []).findIndex((node) => node.id === sourceNodeId);
  return index < 0 ? null : { document, node: document.graph.nodes[index], index };
}

export function nodeDraftFromProject(project, runtimeNode) {
  const sourceNodeId = runtimeNode?.sourceNodeId || runtimeNode?.id;
  const found = findProjectNode(project, runtimeNode?.documentId, sourceNodeId);
  if (!found) return null;
  const raw = found.node;
  const generic = isGenericSchema(found.document.graph);
  return {
    documentId: found.document.id,
    id: String(raw.id || sourceNodeId || ''),
    type: String(raw.type || runtimeNode?.type || ''),
    number: String(raw.number ?? runtimeNode?.number ?? ''),
    title: String(raw.title ?? runtimeNode?.title ?? ''),
    statementBody: String(runtimeNode?.statementBody ?? sectionBody(raw.sections, 'statement') ?? raw.statementBody ?? ''),
    proofBody: String(runtimeNode?.proofBody ?? sectionBody(raw.sections, 'proof') ?? raw.proofBody ?? ''),
    refs: (raw.refs || []).map((ref, index) => ({
      key: String(ref.id || `ref-${index + 1}`),
      target: String(ref.target || ''),
      relation: String(ref.relation || ref.cmd || 'ref'),
      where: ref.where === 'proof' ? 'proof' : 'statement',
    })),
    generic,
  };
}

export function createProjectNode(project, draft) {
  const next = clone(project);
  const document = next.documents.find((item) => item.id === draft.documentId);
  if (!document) throw new Error('请选择节点所属文件');
  document.graph ||= { meta: { title: document.name || '文档' }, nodes: [] };
  document.graph.nodes ||= [];
  if (document.graph.nodes.some((node) => node.id === draft.id)) throw new Error(`节点 ID「${draft.id}」已存在`);
  document.graph.nodes.push(buildRawNode(document.graph, draft));
  syncRuntimeEdges(document.graph);
  enableDocument(next, document.id);
  return next;
}

export function updateProjectNode(project, documentId, sourceNodeId, draft) {
  const next = clone(project);
  const found = findProjectNode(next, documentId, sourceNodeId);
  if (!found) throw new Error('找不到节点的原始数据');
  found.document.graph.nodes[found.index] = updateRawNode(found.document.graph, found.node, draft);
  syncRuntimeEdges(found.document.graph);
  return next;
}

export function deleteProjectNode(project, documentId, sourceNodeId, runtimeNodeId = sourceNodeId) {
  const next = clone(project);
  const found = findProjectNode(next, documentId, sourceNodeId);
  if (!found) throw new Error('找不到要删除的节点');
  const targetIds = new Set([
    sourceNodeId,
    ...(found.node.anchors || []).map((anchor) => anchor.id),
    ...(found.node.labels || []).map((label) => label.id),
  ].filter(Boolean));
  const globallyOwned = anchorOwnerCounts(next);
  found.document.graph.nodes.splice(found.index, 1);

  for (const document of next.documents || []) {
    for (const node of document.graph?.nodes || []) {
      node.refs = (node.refs || []).filter((ref) => !referenceTargetsDeletedNode(
        ref.target, document.id, found.document, targetIds, globallyOwned,
      ));
    }
    if (Array.isArray(document.graph?.edges)) {
      document.graph.edges = document.graph.edges.filter((edge) => edge.from !== sourceNodeId && edge.to !== sourceNodeId);
    }
    syncRuntimeEdges(document.graph);
  }

  const tags = (next.config?.tags || []).map((tag) => ({
    ...tag,
    members: (tag.members || []).filter((member) => memberNode(member) !== runtimeNodeId),
  }));
  next.config = {
    ...(next.config || {}),
    tags,
    disabledNodeIds: (next.config?.disabledNodeIds || []).filter((id) => id !== sourceNodeId && id !== runtimeNodeId),
    disabledRelationKeys: (next.config?.disabledRelationKeys || []).filter((key) => {
      const [from, _label, to] = String(key).split('|');
      return ![sourceNodeId, runtimeNodeId].includes(from) && ![sourceNodeId, runtimeNodeId].includes(to);
    }),
  };
  return next;
}

export function validateNodeDraft(project, draft, { creating = false } = {}) {
  const errors = [];
  const id = String(draft?.id || '').trim();
  if (!id) errors.push('节点 ID 不能为空');
  else if (/\s/.test(id)) errors.push('节点 ID 不能包含空格');
  if (!draft?.documentId || !(project?.documents || []).some((doc) => doc.id === draft.documentId)) errors.push('请选择节点所属文件');
  if (!String(draft?.type || '').trim()) errors.push('请选择节点类型');
  if (creating && id && findProjectNode(project, draft.documentId, id)) errors.push(`节点 ID「${id}」已存在`);
  for (const ref of draft?.refs || []) {
    if (!String(ref.target || '').trim()) errors.push('引用目标不能为空');
  }
  return [...new Set(errors)];
}

export function availableReferenceTargets(project) {
  const result = new Set();
  for (const document of project?.documents || []) {
    const scopeNames = [document.id, slug(document.name)].filter(Boolean);
    for (const node of document.graph?.nodes || []) {
      const ids = new Set([node.id, ...(node.anchors || []).map((a) => a.id), ...(node.labels || []).map((l) => l.id)].filter(Boolean));
      for (const id of ids) {
        // Unscoped ids are valid inside their own document even when another
        // document exposes the same id; scoped variants remain available for
        // explicit cross-document references.
        result.add(id);
        for (const scope of scopeNames) result.add(`${scope}/${id}`);
      }
    }
  }
  return [...result].sort((a, b) => a.localeCompare(b));
}

function buildRawNode(graph, draft) {
  const refs = normalizeDraftRefs(draft.refs, isGenericSchema(graph));
  if (isGenericSchema(graph)) {
    return {
      id: draft.id,
      type: draft.type,
      number: draft.number || '',
      title: draft.title || '',
      sections: sectionsFromDraft([], draft),
      anchors: [{ id: draft.id, kind: 'node', number: draft.number || '' }],
      refs,
    };
  }
  return {
    id: draft.id,
    type: draft.type,
    number: draft.number || '',
    title: draft.title || '',
    statementBody: draft.statementBody || '',
    proofBody: draft.proofBody || '',
    labels: [{ id: draft.id, kind: draft.type || 'node', number: draft.number || '' }],
    refs,
  };
}

function updateRawNode(graph, raw, draft) {
  const generic = isGenericSchema(graph);
  const next = {
    ...raw,
    type: draft.type,
    number: draft.number || '',
    title: draft.title || '',
    refs: mergeDraftRefs(raw.refs || [], draft.refs || [], generic),
  };
  if (generic) next.sections = sectionsFromDraft(raw.sections || [], draft);
  else {
    next.statementBody = draft.statementBody || '';
    next.proofBody = draft.proofBody || '';
    next.labels = (raw.labels || []).map((label) => label.id === raw.id
      ? { ...label, kind: draft.type || label.kind, number: draft.number || '' }
      : label);
  }
  return next;
}

function sectionsFromDraft(current, draft) {
  const sections = current.map((section) => ({ ...section }));
  setSection(sections, 'statement', draft.statementBody || '', true);
  setSection(sections, 'proof', draft.proofBody || '', false);
  return sections;
}

function setSection(sections, kind, body, required) {
  const index = sections.findIndex((section) => section.kind === kind);
  if (index >= 0) {
    if (body || required) sections[index] = { ...sections[index], body };
    else sections.splice(index, 1);
  } else if (body || required) sections.push({ kind, body });
}

function sectionBody(sections, kind) {
  return Array.isArray(sections) ? sections.find((section) => section.kind === kind)?.body : undefined;
}

function normalizeDraftRefs(refs, generic) {
  return (refs || []).map((ref, index) => generic
    ? { id: ref.key || `ref-${index + 1}`, target: ref.target.trim(), relation: ref.relation || 'ref', where: ref.where || 'statement' }
    : { id: ref.key || `ref-${index + 1}`, target: ref.target.trim(), cmd: ref.relation || 'ref', where: ref.where || 'statement' });
}

function mergeDraftRefs(current, refs, generic) {
  const byId = new Map(current.map((ref) => [String(ref.id || ''), ref]));
  return normalizeDraftRefs(refs, generic).map((ref) => ({ ...byId.get(String(ref.id || '')), ...ref }));
}

function enableDocument(project, documentId) {
  project.config ||= {};
  const enabled = new Set(project.config.enabledDocumentIds || []);
  enabled.add(documentId);
  project.config.enabledDocumentIds = [...enabled];
}

function anchorOwnerCounts(project) {
  const counts = new Map();
  for (const document of project?.documents || []) {
    for (const node of document.graph?.nodes || []) {
      const ids = new Set([node.id, ...(node.anchors || []).map((a) => a.id), ...(node.labels || []).map((l) => l.id)].filter(Boolean));
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

function referenceTargetsDeletedNode(target, currentDocId, deletedDoc, targetIds, counts) {
  if (!target) return false;
  if (currentDocId === deletedDoc.id && targetIds.has(target)) return true;
  const slash = String(target).indexOf('/');
  if (slash > 0) {
    const scope = target.slice(0, slash);
    const id = target.slice(slash + 1);
    return (scope === deletedDoc.id || slug(scope) === slug(deletedDoc.name)) && targetIds.has(id);
  }
  return targetIds.has(target) && (counts.get(target) || 0) === 1;
}

function syncRuntimeEdges(graph) {
  if (!graph || isGenericSchema(graph) || !Array.isArray(graph.edges)) return;
  const owner = new Map();
  for (const node of graph.nodes || []) {
    for (const label of node.labels || []) if (!owner.has(label.id)) owner.set(label.id, node.id);
    if (!owner.has(node.id)) owner.set(node.id, node.id);
  }
  const edges = [];
  const seen = new Set();
  for (const node of graph.nodes || []) {
    for (const ref of node.refs || []) {
      const from = owner.get(ref.target);
      if (!from || from === node.id || ref.internal) continue;
      const key = `${from}|${ref.target}|${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, fromLabel: ref.target, to: node.id, relation: ref.relation || ref.cmd || 'ref' });
    }
  }
  graph.edges = edges;
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
