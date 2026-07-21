import { compileGraph } from '../data/adapter.js';
import { mergeProfile, normalizeTags } from '../data/schema.js';
import { normalizeProjectNotes, stripEmbeddedNotes } from '../data/notes.js';

export const PROJECT_FORMAT = 'tracegraph-project@1';

export function createDemoProject(rawGraph) {
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    id: 'project-hardy-demo',
    name: 'Hardy 唯一延拓性样例项目',
    createdAt: now,
    updatedAt: now,
    config: {
      enabledDocumentIds: ['doc-hardy'],
      disabledNodeIds: [],
      disabledRelationKeys: [],
      viewState: {},
    },
    documents: [
      {
        id: 'doc-hardy',
        name: rawGraph?.meta?.title || 'Hardy 论文样例',
        sourceType: 'structured-json',
        importedAt: now,
        graph: rawGraph,
      },
    ],
  };
}

export function normalizeProject(project) {
  const now = new Date().toISOString();
  const docs = Array.isArray(project?.documents) ? project.documents : [];
  const enabled = project?.config?.enabledDocumentIds?.length ? project.config.enabledDocumentIds : docs.map((d) => d.id);
  const tagsWithLegacyNotes = normalizeTags(Array.isArray(project?.config?.tags) ? project.config.tags : []);
  const notes = normalizeProjectNotes(project?.config?.notes, tagsWithLegacyNotes);
  const tags = stripEmbeddedNotes(tagsWithLegacyNotes);
  return {
    format: PROJECT_FORMAT,
    id: project?.id || `project-${Date.now()}`,
    // 保留空字符串作为「尚未命名」标记（配置弹窗据此显示占位名并在保存时落实）；仅缺省(undefined)才兜底
    name: typeof project?.name === 'string' ? project.name : '未命名项目',
    createdAt: project?.createdAt || now,
    updatedAt: project?.updatedAt || now,
    sync: project?.sync && typeof project.sync === 'object'
      ? { state: project.sync.state || 'local', location: project.sync.location || 'local', syncedAt: project.sync.syncedAt || '' }
      : { state: 'local', location: 'local', syncedAt: '' },
    config: {
      enabledDocumentIds: enabled,
      disabledNodeIds: project?.config?.disabledNodeIds || [],
      disabledRelationKeys: project?.config?.disabledRelationKeys || [],
      allowNodeEditing: project?.config?.allowNodeEditing === true,
      tags,
      notes,
      viewState: project?.config?.viewState || {},
    },
    documents: docs.map((doc, i) => ({
      id: doc.id || `doc-${i + 1}`,
      name: doc.name || `文档 ${i + 1}`,
      sourceType: doc.sourceType || 'structured-json',
      importedAt: doc.importedAt || now,
      graph: doc.graph || { meta: { title: doc.name || `文档 ${i + 1}` }, nodes: [], edges: [] },
    })),
  };
}

export function graphToDocument(graph, name, sourceType = 'structured-json') {
  const title = graph?.meta?.title || name || '导入文档';
  return {
    id: uniqueId('doc'),
    name: title,
    sourceType,
    importedAt: new Date().toISOString(),
    graph,
  };
}

export function removeProjectDocuments(project, documentIds) {
  const remove = new Set(documentIds || []);
  if (!remove.size) return normalizeProject(project);
  const normalized = normalizeProject(project);
  const remainingDocs = normalized.documents.filter((doc) => !remove.has(doc.id));
  const removedDocs = normalized.documents.filter((doc) => remove.has(doc.id));
  const remainingIds = new Set(remainingDocs.map((doc) => doc.id));
  const removedNodeIds = new Set(removedDocs.flatMap((doc) => (doc.graph?.nodes || []).map((node) => node.id)));
  const removedRelationKeys = new Set(removedDocs.flatMap((doc) => (doc.graph?.edges || []).map((edge) => relationKey(edge.from, edge.fromLabel, edge.to))));

  return normalizeProject({
    ...normalized,
    documents: remainingDocs,
    config: {
      ...normalized.config,
      enabledDocumentIds: normalized.config.enabledDocumentIds.filter((id) => remainingIds.has(id)),
      disabledNodeIds: normalized.config.disabledNodeIds.filter((id) => !removedNodeIds.has(id)),
      disabledRelationKeys: normalized.config.disabledRelationKeys.filter((key) => !removedRelationKeys.has(key)),
    },
  });
}

export function compileProject(project) {
  const normalized = normalizeProject(project);
  const enabledDocs = new Set(normalized.config.enabledDocumentIds || []);
  const disabledNodes = new Set(normalized.config.disabledNodeIds || []);
  const disabledRelations = new Set(normalized.config.disabledRelationKeys || []);
  const docs = normalized.documents.filter((doc) => enabledDocs.has(doc.id));
  const nodes = [];
  const labelOwner = new Map();
  const docLabelOwner = new Map();
  const docAlias = new Map();
  const labelAliases = {};
  const docMetas = [];
  // 跨文档去重：不同文档可能用相同的节点/锚点 id（如各自的 method:training、eq:1），
  // 若不唯一化，nodeById / nodeEls 会被覆盖，导致该节点无法拖拽、展开后原圆不消失等。
  // 这里为冲突的 id 重命名，同时把解析用的 owner 仍以“原始 id”登记，保证引用照常解析。
  const usedNodeIds = new Set();
  const usedLabelIds = new Set();
  // (docId -> Map(原始 node id -> 唯一化后 id))，用于把图级标签的 members 重映射
  const docNodeIdMap = new Map();
  const uniqueId2 = (orig, docId, used) => {
    if (!used.has(orig)) return orig;
    let k = 2, cand = `${orig}#${docId}`;
    while (used.has(cand)) cand = `${orig}#${docId}-${k++}`;
    return cand;
  };

  for (const doc of docs) {
    docAlias.set(doc.id, doc.id);
    docAlias.set(doc.name, doc.id);
    docAlias.set(slug(doc.name), doc.id);
    docLabelOwner.set(doc.id, new Map());
    docNodeIdMap.set(doc.id, new Map());
    const compiled = compileGraph(doc.graph);
    docMetas.push(compiled.meta);
    for (const rawNode of compiled.nodes || []) {
      if (disabledNodes.has(rawNode.id)) continue;
      const origId = rawNode.id;
      const newId = uniqueId2(origId, doc.id, usedNodeIds);
      usedNodeIds.add(newId);
      docNodeIdMap.get(doc.id).set(origId, newId);

      // 标签：自锚点（id === 节点原 id）跟随新节点 id；其余锚点按需唯一化。
      // _origId 记录原始 id，供下面以“原始 id”登记 owner（引用用原始 target 解析）。
      const labels = (rawNode.labels || []).map((l) => {
        const lid = l.id === origId ? newId : uniqueId2(l.id, doc.id, usedLabelIds);
        usedLabelIds.add(lid);
        return { ...l, id: lid, _origId: l.id };
      });

      const node = {
        ...rawNode,
        id: newId,
        sourceNodeId: origId,
        documentId: doc.id,
        documentName: doc.name,
        labels,
        refs: (rawNode.refs || []).map((r) => ({ ...r })),
      };
      nodes.push(node);
      const dm = docLabelOwner.get(doc.id);
      for (const label of labels) {
        const oid = label._origId;
        if (!labelOwner.has(oid)) labelOwner.set(oid, { node, label });
        dm.set(oid, { node, label });
        dm.set(`${doc.id}/${oid}`, { node, label });
        dm.set(`${slug(doc.name)}/${oid}`, { node, label });
        labelAliases[`${doc.id}/${oid}`] = { nodeId: newId, labelId: label.id };
        labelAliases[`${slug(doc.name)}/${oid}`] = { nodeId: newId, labelId: label.id };
      }
    }
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  const seen = new Set();
  for (const node of nodes) {
    for (const ref of node.refs || []) {
      const resolvedTarget = resolveTarget(ref.target, node.documentId, labelOwner, docLabelOwner, docAlias);
      const owner = resolvedTarget?.owner;
      if (!owner || !nodeById.has(owner.node.id)) {
        ref.resolved = false;
        ref.targetNode = ref.targetNode || null;
        continue;
      }
      ref.resolved = true;
      ref.targetNode = owner.node.id;
      ref.target = resolvedTarget.labelId;
      ref.internal = owner.node.id === node.id;
      if (ref.internal) continue;
      const key = relationKey(owner.node.id, ref.target, node.id);
      if (disabledRelations.has(key) || seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: owner.node.id, fromLabel: ref.target, to: node.id, relation: ref.relation || ref.cmd || 'ref' });
    }
  }

  const firstMeta = docMetas[0] || {};

  // 合并各启用文档的 profile 类型：多文件时每个文档自带的领域类型/配色都要保留，
  // 否则只有第一篇的类型有颜色、其余全部退回灰色。按出现顺序去重（首次定义为准）。
  const baseProfile = firstMeta?.profileResolved;
  const mergedTypes = [];
  const seenType = new Set();
  for (const m of docMetas) {
    for (const t of m?.profileResolved?.types || []) {
      if (seenType.has(t.id)) continue;
      seenType.add(t.id);
      mergedTypes.push({ ...t, order: mergedTypes.length }); // 重排 order，保持按文档分组的出现顺序
    }
  }
  const profileResolved = baseProfile
    ? mergeProfile({ ...baseProfile, types: mergedTypes.length ? mergedTypes : baseProfile.types })
    : undefined;
  const isLeafType = (type) => !!profileResolved?.typeById?.[type]?.leaf || type === 'bib';

  // 标签合并：config.tags（用户编辑，成员已是唯一化后的 id）为准；
  // 各文档图级 graph.tags（导入/prompt 生成，成员为原始 id）按文档重映射后作为 seed 追加。
  const memNode = (m) => (typeof m === 'string' ? m : m && m.node);
  const keepMember = (m) => nodeById.has(memNode(m));
  const tagById = new Map();
  for (const t of normalizeTags(normalized.config.tags)) {
    // config.tags 成员已是唯一化后的 id，仅过滤不存在的
    tagById.set(t.id, { ...t, members: t.members.filter(keepMember) });
  }
  for (const doc of docs) {
    const map = docNodeIdMap.get(doc.id) || new Map();
    const remap = (m) => (typeof m === 'string' ? (map.get(m) || m) : { ...m, node: map.get(m.node) || m.node });
    for (const t of normalizeTags(doc.graph?.tags)) {
      if (tagById.has(t.id)) continue; // 已被 config 覆盖
      tagById.set(t.id, { ...t, members: t.members.map(remap).filter(keepMember) });
    }
  }
  const tags = [...tagById.values()];

  return {
    meta: {
      ...firstMeta,
      title: normalized.name,
      source: 'project',
      projectId: normalized.id,
      projectName: normalized.name,
      documents: docs.map((d) => ({ id: d.id, name: d.name, sourceType: d.sourceType })),
      labelAliases,
      profileResolved, // 合并后的 profile，覆盖首篇单独的 profileResolved
      tags,
      counts: {
        statements: nodes.filter((n) => !isLeafType(n.type)).length,
        bib: nodes.filter((n) => isLeafType(n.type)).length,
        edges: edges.length,
        labels: nodes.reduce((sum, n) => sum + (n.labels?.length || 0), 0),
      },
    },
    types: mergedTypes.length ? mergedTypes : baseProfile?.types,
    nodes,
    edges,
    tags,
  };
}

function resolveTarget(target, currentDocId, labelOwner, docLabelOwner, docAlias) {
  // labelId 用 owner 实际（可能已唯一化）的 label.id，保证边的 fromLabel 能在目标节点上命中锚点
  const currentDocLabels = docLabelOwner.get(currentDocId);
  if (currentDocLabels?.has(target)) { const owner = currentDocLabels.get(target); return { owner, labelId: owner.label.id }; }

  const slash = String(target || '').indexOf('/');
  if (slash > 0) {
    const scope = target.slice(0, slash);
    const labelId = target.slice(slash + 1);
    const docId = docAlias.get(scope) || docAlias.get(slug(scope));
    const scopedOwner = docId ? docLabelOwner.get(docId)?.get(labelId) : null;
    if (scopedOwner) return { owner: scopedOwner, labelId: scopedOwner.label.id };
  }

  const globalOwner = labelOwner.get(target);
  return globalOwner ? { owner: globalOwner, labelId: globalOwner.label.id } : null;
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function relationKey(from, fromLabel, to) {
  return `${from}|${fromLabel}|${to}`;
}

export function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
